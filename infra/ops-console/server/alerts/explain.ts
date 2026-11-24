/**
 * Чистая логика «что это значит и что делать» для уведомлений — без БД, покрыта тестами.
 * Цель: по одному сообщению в Telegram понять причину без захода на сервер.
 */
import { humanDuration } from '../lib/time'
import type { Fact } from './store'

export interface ContainerView {
  name: string
  /** Сервис compose (label com.docker.compose.service); пусто — контейнер не из compose. */
  composeService?: string
  image: string
  state: string
  status: string
  health: string
  healthLog: string
  restartPolicy: string
  exitCode: number | null
  oomKilled: boolean
  restartCount: number
  startedAt: number | null
  cpuPct: number | null
  memMb: number | null
  memLimitMb: number | null
  /** Убито ядром по нехватке памяти, всего у контейнера (журнал ядра, агент ≥ 1.4). */
  oomKills?: number | null
  /** Пик памяти с запуска, МБ (агент ≥ 1.4). */
  memPeakMb?: number | null
  /** Пик swap с запуска, МБ (агент ≥ 1.4). */
  swapPeakMb?: number | null
  /** Кого ядро убило по нехватке памяти за 3 суток (агент ≥ 1.4). */
  oomVictims?: string | null
  /** Стек продукта (основной compose-проект агента); соседние стеки — см. isContainerDown. */
  mainStack?: boolean
}

export const mb = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v >= 1024 ? `${(v / 1024).toFixed(1)} ГБ` : `${Math.round(v)} МБ`

/** Что означает код выхода контейнера — и куда смотреть. */
export function explainExit(c: Pick<ContainerView, 'name' | 'exitCode' | 'oomKilled' | 'memLimitMb'>): string {
  const logs = `docker logs --tail 100 ${c.name}`
  if (c.oomKilled || c.exitCode === 137) {
    const limit = c.memLimitMb ? ` (лимит ${mb(c.memLimitMb)})` : ''
    return c.oomKilled
      ? `Убит ядром по нехватке памяти (OOM)${limit} — поднимите лимит или ищите утечку: ${logs}`
      : `Код 137 = SIGKILL: чаще всего нехватка памяти (OOM)${limit} или docker kill. Смотрите: ${logs}`
  }
  switch (c.exitCode) {
    case 0:
      return `Процесс завершился штатно (код 0), но по restart policy должен работать — смотрите, почему он вышел: ${logs}`
    case 1:
      return `Код 1 — ошибка приложения при работе или старте. Причина в логах: ${logs}`
    case 126:
    case 127:
      return `Код ${c.exitCode} — команда запуска не найдена или не исполняется (битый образ/entrypoint). Проверьте образ и ${logs}`
    case 139:
      return `Код 139 = SIGSEGV: процесс упал с ошибкой памяти. Смотрите: ${logs}`
    case 143:
      return `Код 143 = SIGTERM: контейнер остановили (docker stop, деплой, перезапуск). Если это не плановая остановка — ${logs}`
    default:
      return c.exitCode === null ? `Смотрите: ${logs}` : `Код выхода ${c.exitCode}. Смотрите: ${logs}`
  }
}

export function containerFacts(c: ContainerView, now = Date.now()): Fact[] {
  const facts: Fact[] = [['Состояние', `${c.state}${c.exitCode !== null && c.state !== 'running' ? ` (код ${c.exitCode})` : ''}`]]
  if (c.oomKilled) facts.push(['OOM', 'да — убит по нехватке памяти'])
  if (c.health !== 'none') facts.push(['Healthcheck', c.health])
  if (c.healthLog && c.health === 'unhealthy') facts.push(['Последняя проверка', c.healthLog])
  facts.push(['Перезапусков демоном', String(c.restartCount)])
  if (c.state === 'running' && c.startedAt) facts.push(['Аптайм', humanDuration(now - c.startedAt)])
  if (c.memMb !== null) facts.push(['Память', `${mb(c.memMb)}${c.memLimitMb ? ` из ${mb(c.memLimitMb)}` : ''}`])
  if (c.memPeakMb != null) facts.push(['Пик памяти с запуска', `${mb(c.memPeakMb)}${c.memLimitMb ? ` из ${mb(c.memLimitMb)}` : ''}`])
  if (c.swapPeakMb) facts.push(['Пик swap с запуска', mb(c.swapPeakMb)])
  if (c.oomKills) facts.push(['Убито ядром (OOM), всего', String(c.oomKills)])
  if (c.oomVictims) facts.push(['Кого убило ядро (3 сут.)', c.oomVictims])
  if (c.image) facts.push(['Образ', c.image])
  return facts
}

/** Процесс упёрся в потолок памяти контейнера и убит ядром — что это значит и куда смотреть. */
export function explainOom(c: Pick<ContainerView, 'name' | 'memLimitMb' | 'memPeakMb' | 'swapPeakMb' | 'oomVictims'>): string {
  const after =
    'Убит главный процесс — контейнер перезапустился; вспомогательный — контейнер работает без него, и часть сервиса могла перестать работать.'
  // «(память хоста)» агент ставит у убитых при global_oom: кончилась память всего сервера, а не потолок контейнера.
  if (c.oomVictims?.includes('(память хоста)')) {
    return (
      `Кончилась память всего сервера, и ядро убило процесс в этом контейнере, чтобы освободить её. ${after} ` +
      'Поднимать потолок этому контейнеру бесполезно — ищите, кто занял память хоста: free -m; docker stats --no-stream.'
    )
  }
  const limit = c.memLimitMb ? ` (потолок ${mb(c.memLimitMb)})` : ''
  const peak = c.memPeakMb != null ? ` Пик с запуска — ${mb(c.memPeakMb)}` : ''
  const swap = c.swapPeakMb ? `, swap — ${mb(c.swapPeakMb)}` : ''
  return (
    `Процесс в контейнере упёрся в потолок памяти${limit} и убит ядром. ${after}${peak}${swap}${peak ? '.' : ''} ` +
    `Поднимите deploy.resources.limits.memory этого сервиса в compose или ищите, что ест память: docker stats ${c.name}; journalctl -k | grep 'oom-kill:'.`
  )
}

/** Почему unhealthy и что делать: вывод последней проверки — самое ценное. */
export function explainUnhealthy(c: Pick<ContainerView, 'name' | 'healthLog'>): string {
  const inspect = `docker inspect --format '{{json .State.Health}}' ${c.name}`
  return c.healthLog
    ? `Проверка отвечает: «${c.healthLog}». Логи: docker logs --tail 100 ${c.name}; история проверок: ${inspect}`
    : `Healthcheck не проходит. История проверок: ${inspect}; логи: docker logs --tail 100 ${c.name}`
}

/** «backend 4.1 ГБ · whisper 1.6 ГБ · kafka 0.7 ГБ» — кто ест ресурс. */
export function topConsumers(containers: ContainerView[], by: 'mem' | 'cpu', n = 3): string {
  const rows = containers
    .filter((c) => (by === 'mem' ? c.memMb : c.cpuPct) !== null)
    .sort((a, b) => (by === 'mem' ? (b.memMb ?? 0) - (a.memMb ?? 0) : (b.cpuPct ?? 0) - (a.cpuPct ?? 0)))
    .slice(0, n)
  return rows.map((c) => `${c.name} ${by === 'mem' ? mb(c.memMb) : `${(c.cpuPct ?? 0).toFixed(0)}%`}`).join(' · ')
}

/** Подсказка по метрике хоста. */
export function metricHint(metric: string): string {
  if (metric === 'mem_pct' || metric === 'swap_used_mb')
    return 'Кто ест память — в фактах выше. Проверьте утечки и лимиты контейнеров (deploy.resources.limits.memory).'
  if (metric === 'cpu_pct' || metric === 'load1')
    return 'Кто грузит CPU — в фактах выше. Проверьте фоновые задачи и пики трафика (nginx rpm).'
  if (metric === 'disk_pct')
    return 'Освободить место: docker system df, docker image prune -a, docker builder prune; проверьте логи и бэкапы.'
  if (metric.startsWith('nginx_5xx'))
    return 'Сервер отвечает ошибками — смотрите логи backend и nginx: docker logs --tail 200 backend-backend-1.'
  if (metric === 'docker_ok') return 'Агент не может получить ответ от docker CLI: проверьте systemctl status docker и нагрузку на сервер.'
  return BIZ_HINTS[metric] ?? ''
}

const SM_LOGS = 'docker logs --tail 200 backend-telegram-sessions-1; ранбук — docs/ops/telegram-session-manager.md'

/**
 * Бизнес-метрики P0 считаются только по замерам агента ≥ 1.3: отчёт без времени замера (старый агент) их правила
 * не оценивает — иначе «2 замера» превратились бы в 2 отчёта, то есть в 30 секунд.
 */
export const isMeasuredBizMetric = (metric: string) => Object.hasOwn(BIZ_HINTS, metric)

/** Подсистема P0 — объект алерта: инциденты собираются по объекту, и сбой Huntflow не должен втягивать STT и диск. */
export function bizSubsystem(metric: string): string | null {
  const key = metric.startsWith('biz_') ? metric.slice(4).split('_')[0] : ''
  return key === 'stt' ? 'STT' : key === 'tg' ? 'Telegram' : key === 'hf' ? 'Huntflow' : key === 'redis' ? 'Очереди' : null
}

/** P0 продукта (docs/ops/p0-slo-alerts.md): что значит бизнес-метрика за порогом и куда смотреть. */
const BIZ_HINTS: Record<string, string> = {
  biz_stt_failed_1h:
    'Распознавание встреч падает (failed, «Распознавание не удалось/прервалось»). Причина — в логах: docker logs --tail 200 backend-whisper-1 и backend-backend-1.',
  biz_stt_diarization_failed_1h:
    'У готовых записей не выполнилась разметка говорящих: транскрипт есть, но без говорящих, в карточке встречи — пометка с причиной и кнопка «Переразметить». Причина — в пометке и в логах: docker logs --tail 200 backend-diarization-1 и backend-backend-1. Запись длиннее 2 часов sidecar не размечает — это предел, а не сбой.',
  biz_stt_stuck:
    'Записи висят в processing дольше 4 ч (файлы больше 1,5 ГБ — 6 ч): задача потеряна (перезапуск Redis, неудачная уборка зависшей задачи) или вызов без таймаута. Зависание whisper дольше 90 минут обычно видно раньше как сбой распознавания. Запись без живой задачи сама не вернётся: в базе status = \'uploaded\' для неё (where id = … and status = \'processing\'), затем «Распознать заново» в карточке встречи.',
  biz_stt_orphaned:
    'Записи ждут распознавания (uploaded), а задач для них в очереди meeting-stt нет: постановка сорвалась или очередь потерялась при перезапуске Redis. Сами они не начнутся — «Распознать заново» в карточке встречи; найти: tenant_meeting_recordings со status = \'uploaded\' старше 30 минут.',
  biz_stt_queue_waiting:
    'Задачи копятся в очереди meeting-stt: распознавание не успевает или стоит. Проверьте контейнеры backend-whisper-1 и backend-backend-1.',
  biz_stt_queue_stalled:
    'Задачи распознавания ждут, а в работе ни одной — обработчик очереди meeting-stt их не берёт: backend перезапускается или упал воркер. Длинная очередь, которая разбирается, сюда не попадает; недоступный Redis очередей — тоже: тогда метрика не считается вовсе (правило «Бизнес-метрики не считаются»). Проверьте docker logs --tail 200 backend-backend-1 (MeetingSttProcessor).',
  biz_tg_api_5xx_pct:
    'Маршруты Telegram отвечают 500/502/504 (по журналу nginx): backend упал, не отвечает или падает с ошибкой кода. Проверьте контейнер backend-backend-1 и его логи: docker logs --tail 200 backend-backend-1.',
  biz_tg_api_503_pct: `Backend отказывает по Telegram с 503: у аккаунтов открыт circuit breaker Session Manager, FLOOD_WAIT, конфликт владения сессией или таймаут MTProto. Обычно это один-два аккаунта, а не платформа. ${SM_LOGS}.`,
  biz_tg_evictions_1h: `Session Manager массово выселяет сессии за последний час (так выглядел инцидент 25.09): конфликт владения или вотчдог. ${SM_LOGS}.`,
  biz_tg_subs_coverage_pct:
    'У части живых клиентов Session Manager нет realtime-подписки backend: новые сообщения Telegram не приходят сразу. Ищите «Subscribe stream error» в логах backend-backend-1 и проверьте Session Manager.',
  biz_hf_refresh_rejected:
    'Huntflow отклонил пару токенов: интеграция стоит, пока владелец подключения заново не войдёт в Huntflow в настройках интеграций.',
  biz_hf_refresh_errors_6h:
    'Обновление токена Huntflow падает: сеть, лимиты или ответ Huntflow. Логи: docker logs --tail 200 backend-backend-1 | grep -i huntflow.',
  biz_redis_queue_mem_pct:
    'Redis очередей (redis-queue) не вытесняет ключи: заполнится — постановка любой задачи (расшифровка, уведомления, публикации) начнёт падать с ошибкой. Что растёт: docker exec backend-redis-queue-1 redis-cli --bigkeys; обычно это незавершённые или упавшие задачи одной очереди. Поднять maxmemory — command в infra/docker/docker-compose.yml (redis-queue) и потолок в docker-compose.contabo.yml.',
  biz_failed:
    'Команды BUSINESS_CMDS на сервере падают, и правила по этим метрикам ничего не видят. Запустите /opt/hrh-ops/hrh-business.sh <ключ> на сервере: чаще всего переименован контейнер или недоступна база.',
}

/** Человеческое имя метрики для сообщения. */
export function metricLabel(metric: string): string {
  const m: Record<string, string> = {
    cpu_pct: 'CPU',
    mem_pct: 'Память',
    disk_pct: 'Диск (самый заполненный)',
    load1: 'Load average',
    swap_used_mb: 'Swap',
    nginx_5xx_rpm: '5xx в минуту',
    nginx_4xx_rpm: '4xx в минуту',
    nginx_rpm: 'Запросов в минуту',
    docker_ok: 'Docker отвечает',
    biz_stt_failed_1h: 'Сбоев расшифровки за час',
    biz_stt_diarization_failed_1h: 'Записей без разметки говорящих за час',
    biz_stt_stuck: 'Застрявших записей',
    biz_stt_orphaned: 'Записей без задачи',
    biz_stt_queue_waiting: 'В очереди расшифровки',
    biz_stt_queue_stalled: 'Задач ждут, обработчик не берёт',
    biz_tg_api_5xx_pct: 'Ошибки API Telegram (кроме 503)',
    biz_tg_api_503_pct: 'Отказы Telegram (503)',
    biz_tg_evictions_1h: 'Выселений сессий за час',
    biz_tg_subs_coverage_pct: 'Сессий с живой подпиской',
    biz_hf_refresh_rejected: 'Huntflow: отклонённых токенов',
    biz_hf_refresh_errors_6h: 'Huntflow: сбоев обновления за 6 ч',
    biz_failed: 'Не посчитано бизнес-метрик',
    biz_redis_queue_mem_pct: 'Redis очередей заполнен',
  }
  return m[metric] ?? metric
}

/** Почему проверка доступности не прошла и что делать — по коду ответа или ошибке соединения. */
export function explainCheckFailure(out: { statusCode: number | null; error: string | null }, timeoutMs: number): string {
  const e = (out.error ?? '').toLowerCase()
  if (e.includes('внутренний адрес'))
    return 'Имя указывает на внутренний адрес. Если это ваш сервис — добавьте имя в «Настройки → Общие → Внутренние адреса»; если имя публичное — проверьте его DNS-запись и URL монитора.'
  if (e.includes('таймаут'))
    return `Сервер не ответил за ${timeoutMs} мс — перегрузка или сеть. Посмотрите CPU/RAM на странице сервера и nginx.`
  if (e.includes('econnrefused'))
    return 'Соединение отклонено — nginx или приложение не слушает порт. Проверьте контейнеры nginx и backend.'
  if (e.includes('enotfound') || e.includes('eai_again') || e.includes('адрес не найден'))
    return 'Имя не резолвится — проверьте DNS-запись (Cloudflare) и что домен не истёк.'
  if (e.includes('cert') || e.includes('self signed') || e.includes('ssl') || e.includes('tls'))
    return 'Проблема с TLS-сертификатом — проверьте certbot и срок сертификата (Мониторинг → TLS).'
  if (e.includes('econnreset') || e.includes('socket hang up'))
    return 'Соединение оборвалось — сервер перезапускается или перегружен. Проверьте контейнеры.'
  if (e.includes('health'))
    return 'Health сообщает о деградации: недоступна зависимость (обычно БД или Redis). Проверьте контейнеры postgres, pgbouncer, redis.'
  if (e.includes('ключевой строки'))
    return 'Страница отвечает, но без ожидаемого текста — вероятно, отдаётся заглушка или страница ошибки nginx.'
  const code = out.statusCode
  if (code !== null && code >= 500) {
    return code === 502 || code === 504
      ? `HTTP ${code} — nginx не достучался до приложения (оно упало, перезапускается или зависло). Проверьте backend/frontend.`
      : `HTTP ${code} — приложение отвечает ошибкой. Смотрите логи: docker logs --tail 200 backend-backend-1.`
  }
  if (code !== null && code >= 400)
    return `HTTP ${code} — адрес отвечает отказом. Проверьте маршрут и nginx или ожидаемый код в настройках монитора.`
  return 'Проверьте адрес вручную и логи nginx.'
}
