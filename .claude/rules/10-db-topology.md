---
paths:
  - apps/backend/**
  - infra/docker/**
  - infra/k8s/**
---

# DB Topology & Data Flow

## Один инстанс на роль — dev/test/prod одинаково

Postgres, Redis, ClickHouse, MinIO, Kafka — везде единственный инстанс на роль, читает
и пишет один и тот же процесс (`infra/docker/docker-compose.yml`, без отдельного
prod-оверлея с репликами). `PrismaReadService`/`PrismaWriteService`,
`RedisCacheService`, `ClickHouseService` — разделение по классам осталось (SRP: read-
и write-путь — разная ответственность), но оба клиента в каждой паре по умолчанию
смотрят на один и тот же адрес. `DATABASE_READ_URL`/`REDIS_READ_HOST`/
`CLICKHOUSE_READ_HOST` — необязательные escape-hatch переменные: если когда-нибудь
понадобится вынести чтение на отдельный узел, это делается заданием переменной
окружения, без изменения кода. Не заданы — код грациозно падает обратно на primary.
Писать код одинаково независимо от того, заданы эти переменные или нет.

## Топология баз данных HR Helper v2

```
Backend (NestJS)
├── PrismaWriteService ──► PostgreSQL (5432)
│                          - все INSERT/UPDATE/DELETE
│                          - $transaction
│
├── PrismaReadService  ──► PostgreSQL (тот же инстанс, 5432)
│                          - SELECT (90% запросов)
│                          - DATABASE_READ_URL опционален — не задан → primary
│
├── RedisService       ──► Redis `redis` (6379) — кэш: allkeys-lru, без сохранения
│   BullMQ Queues     ──► Redis `redis-queue` (REDIS_QUEUE_HOST) — noeviction + AOF:
│                          очереди не вытесняются и переживают перезапуск (с 2026-10-20)
│
├── ClickHouseService  ──► ClickHouse (8123), ReplacingMergeTree, без Keeper
│                          - CLICKHOUSE_READ_HOST опционален — не задан → primary
│
└── Поиск: федеративный + semantic (pgvector) — modules/search; Elasticsearch в коде НЕТ
```

## Потоки данных — когда что использовать

| Тип операции | Слой | Клиент |
|---|---|---|
| CRUD бизнес-сущностей | PostgreSQL | `PrismaWriteService` |
| Чтение списков, фильтрация | PostgreSQL | `PrismaReadService` |
| Кэш горячих данных | Redis | `CacheService` |
| Фоновые задачи | Redis BullMQ | Queue producers |
| Аналитика, воронки, отчёты | ClickHouse | `ClickHouseService` |
| Поиск (federated + semantic pgvector) | PostgreSQL | `modules/search` |
| Файлы (резюме, фото) | S3/MinIO | `StorageService` |

## После записи — читать в той же транзакции

Один физический инстанс — replication lag не проблема, но `PrismaReadService` и
`PrismaWriteService` остаются разными клиентами (разные пулы соединений). Если нужно
читать СРАЗУ после записи в том же запросе — всё равно делать это на
`PrismaWriteService`, внутри одной транзакции: так гарантируется атомарность
(конкурентная запись между create и последующим read не может проскочить между
двумя разными вызовами), а не обход несуществующего лага.

```typescript
// ❌ Два разных клиента, два отдельных запроса — не атомарно:
const created = await this.db.candidate.create({ data: dto })
const full = await this.dbRead.candidate.findUnique({ where: { id: created.id } })

// ✅ Всё внутри транзакции на PrismaWriteService:
const full = await this.db.$transaction(async (tx) => {
  const c = await tx.candidate.create({ data: dto })
  return tx.candidate.findUniqueOrThrow({ where: { id: c.id }, include: { ... } })
})
```

## Env-переменные

```bash
DATABASE_URL="postgresql://app:secret@postgres:5432/hrhelper?connection_limit=20&pool_timeout=15"
# DATABASE_READ_URL не задан по умолчанию — PrismaReadService падает обратно на DATABASE_URL
REDIS_HOST="redis"
REDIS_PORT="6379"
# REDIS_QUEUE_HOST=redis-queue в compose; не задан (backend вне docker) — BullMQ падает обратно на REDIS_HOST
# CLICKHOUSE_READ_HOST не задан по умолчанию — ClickHouseService падает обратно на primary
```

- `connection_limit` write: 15–25 (транзакции держат соединение дольше)
- `connection_limit` read: 25–40 (короткие запросы, высокий throughput)
- Никогда не убирать `connection_limit` — без него Prisma создаёт 1 коннект на воркер
- Redis — `HOST`/`PORT`-пары, не единый `REDIS_URL`, даже при одном физическом инстансе:
  `REDIS_QUEUE_HOST`/`PORT` — отдельная escape-hatch пара под BullMQ, единая connection
  string не даёт независимо переопределить её без переопределения кэша.
  `apps/telegram-sessions` (отдельный процесс, один Redis, без queue-раздвоения) —
  другой случай, там валиден `REDIS_URL` как connection string.

## Health Check

```typescript
await Promise.allSettled([
  this.db.$queryRaw`SELECT 1`,      // write client
  this.dbRead.$queryRaw`SELECT 1`,  // read client (тот же инстанс по умолчанию)
  this.redis.ping(),
])
```

## Миграции — только через CI/CD

❌ Никогда не вызывать `prisma migrate deploy` в `onModuleInit` или runtime.

Правила нулевого простоя:
- Индексы: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
- Переименование колонки: 3 шага (добавить → дублировать → удалить старую)
- NOT NULL поле: добавить с DEFAULT → деплой → сделать NOT NULL
