/**
 * Встроенный набор правил. Каждое правило создаётся один раз (версия `since` — отметка
 * `builtin_rules_vN` в настройках), дальше владелец меняет пороги или выключает. Новое
 * встроенное правило — следующая версия: оно появится и в уже работающих консолях.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alertRules } from '../db/schema'
import { readMarker, writeMarker } from '../settings/store'

type NewRule = typeof alertRules.$inferInsert & { since: number }
type AlertRule = typeof alertRules.$inferSelect

/** Пакетные сервисы, которым «занят ≠ завис» (container-busy.ts): считают длинную задачу в одном процессе. */
const BUSY_BATCH_SERVICES = 'diarization,whisper'

export const BUILTIN_RULES: NewRule[] = [
  { since: 1, name: 'CPU выше 90%', kind: 'host_metric', metric: 'cpu_pct', op: 'gt', threshold: 90, forSamples: 4, severity: 'warning' },
  {
    since: 1,
    name: 'Память выше 90%',
    kind: 'host_metric',
    metric: 'mem_pct',
    op: 'gt',
    threshold: 90,
    forSamples: 4,
    severity: 'warning',
  },
  {
    since: 1,
    name: 'Диск заполнен > 85%',
    kind: 'host_metric',
    metric: 'disk_pct',
    op: 'gt',
    threshold: 85,
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 1,
    name: 'Диск заполнен > 95%',
    kind: 'host_metric',
    metric: 'disk_pct',
    op: 'gt',
    threshold: 95,
    forSamples: 1,
    severity: 'critical',
  },
  {
    since: 1,
    name: 'Ошибки 5xx в nginx',
    kind: 'host_metric',
    metric: 'nginx_5xx_rpm',
    op: 'gt',
    threshold: 10,
    forSamples: 3,
    severity: 'warning',
  },
  { since: 1, name: 'Контейнер остановлен', kind: 'container_down', forSamples: 2, severity: 'critical', repeatMin: 120 },
  // Занят ≠ завис (s-diar-busy, 21.10): у пакетных сервисов из metric CPU не ниже threshold (% ядра) — расчёт, а не
  // зависание (server/alerts/container-busy.ts). Поле metric здесь — не метрика, а список сервисов через запятую:
  // в редакторе правил это поле «Пакетные сервисы».
  {
    since: 1,
    name: 'Контейнер unhealthy',
    kind: 'container_unhealthy',
    metric: BUSY_BATCH_SERVICES,
    threshold: 20,
    forSamples: 2,
    severity: 'critical',
    repeatMin: 120,
  },
  {
    since: 1,
    name: 'Перезапуски контейнера (restart loop)',
    kind: 'container_restarts',
    threshold: 3,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 60,
  },
  { since: 1, name: 'Агент сервера молчит', kind: 'agent_silent', forSamples: 1, severity: 'critical', repeatMin: 60 },
  { since: 1, name: 'Сайт недоступен', kind: 'monitor_down', forSamples: 2, severity: 'critical', repeatMin: 60 },
  {
    since: 1,
    name: 'TLS-сертификат истекает (< 14 дней)',
    kind: 'tls_expiry',
    op: 'lt',
    threshold: 14,
    forSamples: 1,
    severity: 'warning',
    repeatMin: 1440,
  },
  {
    since: 1,
    name: 'TLS-сертификат истекает (< 3 дней)',
    kind: 'tls_expiry',
    op: 'lt',
    threshold: 3,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 360,
  },
  // Critical с OPS-DEPLOY-VIS фазы 2; в консолях, где строка уже есть, уровень поднимает BUILTIN_UPGRADES.
  { since: 1, name: 'Деплой упал', kind: 'deploy_failed', forSamples: 1, severity: 'critical', repeatMin: 0 },
  // v2: зависший dockerd / недоступный docker CLI (метрика docker_ok из отчёта агента).
  {
    since: 2,
    name: 'Docker не отвечает',
    kind: 'host_metric',
    metric: 'docker_ok',
    op: 'lt',
    threshold: 1,
    forSamples: 4,
    severity: 'critical',
    repeatMin: 60,
  },
  // v3: P0 продукта — расшифровка встреч, Telegram, токены Huntflow (docs/ops/p0-slo-alerts.md, пороги владельца 16.10).
  // Метрики — из agent/hrh-business.sh; пока их нет в BUSINESS_CMDS сервера, правила молчат. forSamples у biz_* —
  // замеры (раз в BUSINESS_INTERVAL_SEC = 300 с), а не отчёты: консоль оценивает их только на новом замере.
  // «Два замера подряд» таблица 16.10 писала при замере раз в час: для счётчиков за окно (сбоев за час, за 6 ч) это
  // ≈ час подряд — 13 замеров; одиночный сбой, который проходит со следующей попыткой, не будит.
  {
    since: 3,
    name: 'STT: сбои распознавания за час',
    kind: 'host_metric',
    metric: 'biz_stt_failed_1h',
    op: 'gt',
    threshold: 0,
    forSamples: 13,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'STT: больше 3 сбоев распознавания за час',
    kind: 'host_metric',
    metric: 'biz_stt_failed_1h',
    op: 'gt',
    threshold: 3,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 60,
  },
  {
    since: 3,
    name: 'STT: записи застряли в обработке',
    kind: 'host_metric',
    metric: 'biz_stt_stuck',
    op: 'gt',
    threshold: 0,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 120,
  },
  {
    since: 3,
    name: 'STT: записи без задачи распознавания',
    kind: 'host_metric',
    metric: 'biz_stt_orphaned',
    op: 'gt',
    threshold: 0,
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'STT: очередь распознавания не разбирается',
    kind: 'host_metric',
    metric: 'biz_stt_queue_waiting',
    op: 'gt',
    threshold: 5,
    // SLO — «не растёт 30 минут»: 7 замеров по 5 минут.
    forSamples: 7,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'Telegram: ошибки API больше 5% (кроме 503)',
    kind: 'host_metric',
    metric: 'biz_tg_api_5xx_pct',
    op: 'gt',
    threshold: 5,
    forSamples: 2,
    severity: 'critical',
    repeatMin: 60,
  },
  {
    since: 3,
    name: 'Telegram: отказы по аккаунтам (503)',
    kind: 'host_metric',
    metric: 'biz_tg_api_503_pct',
    op: 'gt',
    threshold: 5,
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'Telegram: шторм выселений сессий',
    kind: 'host_metric',
    metric: 'biz_tg_evictions_1h',
    op: 'gt',
    threshold: 30,
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'Telegram: мало живых realtime-подписок',
    kind: 'host_metric',
    metric: 'biz_tg_subs_coverage_pct',
    op: 'lt',
    threshold: 80,
    // 2, а не 3–4: клиента без подписки Session Manager выселяет через 15 минут, и покрытие снова 100 %.
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 3,
    name: 'Huntflow: сервис отклонил токен, нужен вход',
    kind: 'host_metric',
    metric: 'biz_hf_refresh_rejected',
    op: 'gt',
    threshold: 0,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 1440,
  },
  {
    since: 3,
    name: 'Huntflow: сбои обновления токена за 6 ч',
    kind: 'host_metric',
    metric: 'biz_hf_refresh_errors_6h',
    op: 'gt',
    threshold: 0,
    // Планировщик повторяет раз в час: сбой, переживший следующую попытку, — ≈ час подряд.
    forSamples: 13,
    severity: 'warning',
  },
  // v4: ядро убило процесс в контейнере по нехватке памяти — контейнер не перезапускается, docker этого почти не
  // показывает (OnlyOffice 18.10, docs/ops/onlyoffice.md). Счётчик oom_kill из cgroup — агент ≥ 1.4.
  {
    since: 4,
    name: 'Нехватка памяти в контейнере',
    kind: 'container_oom',
    threshold: 1,
    forSamples: 1,
    severity: 'warning',
    repeatMin: 60,
  },
  // v4: Redis очередей (redis-queue, noeviction) заполняется — при 100 % постановка любой задачи падает с ошибкой.
  // Метрика появляется после переноса очередей (PR redis-queue и его серверный шаг добавляют ключ в BUSINESS_CMDS).
  {
    since: 4,
    name: 'Redis очередей заполнен больше чем на 80%',
    kind: 'host_metric',
    metric: 'biz_redis_queue_mem_pct',
    op: 'gt',
    threshold: 80,
    forSamples: 2,
    severity: 'warning',
  },
  {
    since: 4,
    name: 'Redis очередей заполнен больше чем на 95%',
    kind: 'host_metric',
    metric: 'biz_redis_queue_mem_pct',
    op: 'gt',
    threshold: 95,
    forSamples: 1,
    severity: 'critical',
    repeatMin: 60,
  },
  // Скрипт метрик упал (переименован контейнер, база недоступна) — иначе P0-правила молча перестали бы видеть.
  {
    since: 3,
    name: 'Бизнес-метрики не считаются',
    kind: 'host_metric',
    metric: 'biz_failed',
    op: 'gt',
    threshold: 0,
    forSamples: 2,
    severity: 'warning',
  },
  // v5 — алерты по событиям деплоя (OPS-DEPLOY-VIS, фаза 2; v4 занят правилами #235). Порог долгого деплоя —
  // минуты: обычный деплой идёт 15–45 мин, потолок задачи GitHub — 120 мин.
  { since: 5, name: 'Деплой идёт слишком долго', kind: 'deploy_slow', threshold: 60, forSamples: 1, severity: 'warning', repeatMin: 0 },
  { since: 5, name: 'Откат по rollback-prev недоступен', kind: 'deploy_rollback_prev', forSamples: 1, severity: 'warning', repeatMin: 0 },
  // v6: у готовой записи не выполнилась разметка говорящих (транскрипт есть, говорящих нет) — раньше это было видно
  // только в логе backend. Не 13 замеров, как у сбоев распознавания: записей мало, а одиночная пометка сама не уйдёт,
  // пока запись не переразметят. Без повтора — одно сообщение на волну; закрывается, когда за час новых пометок нет.
  {
    since: 6,
    name: 'STT: разметка говорящих не выполнена',
    kind: 'host_metric',
    metric: 'biz_stt_diarization_failed_1h',
    op: 'gt',
    threshold: 0,
    forSamples: 1,
    severity: 'warning',
  },
]

/**
 * Правка встроенной строки в уже работающих консолях — один раз, по своей отметке. Строку, которую владелец
 * уже менял (имя или правленое поле не те, что ставила консоль), не трогаем.
 */
type UpgradeFields = Partial<Pick<AlertRule, 'severity' | 'threshold' | 'metric'>>
type BuiltinUpgrade = { marker: string; kind: AlertRule['kind']; name: string; from: UpgradeFields; to: UpgradeFields }
const BUILTIN_UPGRADES: readonly BuiltinUpgrade[] = [
  { marker: 'builtin_upgrade_deploy_failed_critical', kind: 'deploy_failed', name: 'Деплой упал', from: { severity: 'warning' }, to: { severity: 'critical' } },
  // Занят ≠ завис: до 22.10 у unhealthy не было ни порога (0), ни списка — занятая расчётом диаризация подняла P0 #241.
  {
    marker: 'builtin_upgrade_unhealthy_busy_cpu',
    kind: 'container_unhealthy',
    name: 'Контейнер unhealthy',
    from: { threshold: 0, metric: null },
    to: { threshold: 20, metric: BUSY_BATCH_SERVICES },
  },
]
const UPGRADE_COLUMNS = { severity: alertRules.severity, threshold: alertRules.threshold, metric: alertRules.metric } as const

export async function ensureBuiltinRules(): Promise<void> {
  const versions = [...new Set(BUILTIN_RULES.map((r) => r.since))].sort((a, b) => a - b)
  for (const v of versions) {
    if (await readMarker(`builtin_rules_v${v}`)) continue
    const rows = BUILTIN_RULES.filter((r) => r.since === v).map(({ since: _since, ...rule }) => ({
      ...rule,
      builtin: true,
      createdAt: new Date(),
    }))
    await getDb().insert(alertRules).values(rows)
    await writeMarker(`builtin_rules_v${v}`, Date.now())
  }
  for (const u of BUILTIN_UPGRADES) {
    if (await readMarker(u.marker)) continue
    // Каждое поле — там, где его ставила консоль: правленное владельцем значение строку из апгрейда исключает.
    const untouched = (Object.keys(u.from) as (keyof UpgradeFields)[]).map((k) =>
      u.from[k] === null ? isNull(UPGRADE_COLUMNS[k]) : eq(UPGRADE_COLUMNS[k], u.from[k] as never),
    )
    await getDb()
      .update(alertRules)
      .set(u.to)
      .where(and(eq(alertRules.builtin, true), eq(alertRules.kind, u.kind), eq(alertRules.name, u.name), ...untouched))
    await writeMarker(u.marker, Date.now())
  }
}
