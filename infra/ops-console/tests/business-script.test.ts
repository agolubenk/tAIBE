/**
 * agent/hrh-business.sh без сервера: docker, timeout и date подменены скриптами-заглушками, которые отдают
 * фикстуры журнала nginx и текста /metrics. Ключи с SQL здесь проверяются только на контракт с текстами backend —
 * их прогон на проде описан в docs/ops/p0-slo-alerts.md.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = new URL('../agent/hrh-business.sh', import.meta.url).pathname
const realDate = spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim()

function shims(dir: string): string {
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  put(
    'docker',
    `[ -n "\${FAKE_DOCKER_FAIL:-}" ] && exit 1
case "$1" in
  logs) cat "$FAKE_NGINX_LOG" ;;
  inspect)
    [ -n "\${FAKE_INSPECT_FAIL:-}" ] && exit 1
    case "\${@: -1}" in
      backend-telegram-sessions-1) echo "\${FAKE_STARTED_AT_SM:-$FAKE_STARTED_AT}" ;;
      *) echo "$FAKE_STARTED_AT" ;;
    esac ;;
  exec)
    f=""; pg=""
    for a in "$@"; do
      case "$a" in
        backend-backend-1) f="\${FAKE_METRICS_BACKEND:-}" ;;
        backend-telegram-sessions-1) f="\${FAKE_METRICS_SM:-}" ;;
        backend-redis-queue-1) f="\${FAKE_REDIS_INFO:-}" ;;
        backend-postgres-1) pg=1 ;;
      esac
    done
    # psql: SQL со stdin — в журнал запросов, ответ — FAKE_PG_VALUE.
    if [ -n "$pg" ]; then cat >>"$FAKE_SQL_LOG"; echo "\${FAKE_PG_VALUE:-0}"; exit 0; fi
    [ -n "$f" ] && [ -f "$f" ] || exit 1
    cat "$f" ;;
  *) exit 1 ;;
esac`,
  )
  put('timeout', 'shift\nexec "$@"')
  // GNU date -d есть не везде (macOS): разбор ISO — через python, остальное — настоящий date.
  put(
    'date',
    `if [ "\${1:-}" = "-d" ]; then
  python3 -c 'import sys, datetime; print(int(datetime.datetime.strptime(sys.argv[1][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()))' "$2"
  exit
fi
exec ${realDate} "$@"`,
  )
  return bin
}

let dir = ''
let env: Record<string, string> = {}
const file = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}
const run = (key: string, extra: Record<string, string> = {}) => {
  const r = spawnSync('bash', [SCRIPT, key], { env: { ...env, ...extra }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim() }
}
const startedAgo = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()

// Журнал nginx в формате combined: время — поле 4, путь — поле 7, код — поле 9.
const line = (path: string, status: number, minute = 0) =>
  `203.0.113.7 - - [19/Oct/2026:21:${String(minute).padStart(2, '0')}:00 +0000] "GET ${path} HTTP/1.1" ${status} 512 "-" "Mozilla/5.0 (X11; Linux)"`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hrh-business-'))
  env = {
    PATH: `${shims(dir)}:${process.env.PATH ?? ''}`,
    HOME: dir,
    HRH_STATE_DIR: join(dir, 'state'),
    FAKE_STARTED_AT: startedAgo(3600),
    FAKE_SQL_LOG: join(dir, 'sql.log'),
  }
})

describe('hrh-business.sh: ошибки API Telegram по журналу nginx', () => {
  const log = (tg5xx: number, tgOk: number, other: string[] = []) =>
    file(
      'nginx.log',
      [
        ...Array.from({ length: tgOk }, () => line('/api/v1/integrations/telegram/dialogs?limit=50', 200)),
        // Ошибки платформы (500/502/504) разнесены по 4 минутам окна — устойчивый сбой, а не всплеск.
        ...Array.from({ length: tg5xx }, (_, i) => line('/api/v1/integrations/telegram/messages', [500, 502, 504][i % 3]!, i % 4)),
        ...other,
      ].join('\n') + '\n',
    )

  it('503 (отказ по аккаунту) — отдельная метрика: в ошибки платформы не входит', () => {
    const p = file(
      'mixed.log',
      [
        ...Array.from({ length: 80 }, (_, i) => line('/api/v1/integrations/telegram/dialogs', 200, i % 5)),
        ...Array.from({ length: 12 }, (_, i) => line('/api/v1/integrations/telegram/peers/1/avatar', 503, i % 4)),
        ...Array.from({ length: 8 }, (_, i) => line('/api/v1/integrations/telegram/messages', i % 2 ? 502 : 500, i % 4)),
      ].join('\n') + '\n',
    )
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: p })).toEqual({ code: 0, out: '8.00' })
    expect(run('tg_api_503_pct', { FAKE_NGINX_LOG: p })).toEqual({ code: 0, out: '12.00' })
    // Только 503 — ошибок платформы нет.
    const only503 = file(
      'only503.log',
      [
        ...Array.from({ length: 70 }, () => line('/api/v1/integrations/telegram/dialogs', 200, 2)),
        ...Array.from({ length: 30 }, (_, i) => line('/api/v1/integrations/telegram/peers/1/avatar', 503, i % 5)),
      ].join('\n') + '\n',
    )
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: only503 })).toEqual({ code: 0, out: '0.00' })
    expect(run('tg_api_503_pct', { FAKE_NGINX_LOG: only503 })).toEqual({ code: 0, out: '30.00' })
  })

  it('доля 5xx среди маршрутов Telegram; чужие маршруты не в счёт, 499 — запрос, но не ошибка', () => {
    const p = log(6, 94, [line('/api/v1/vacancies', 502), line('/api/v1/integrations/telegramx', 500)])
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: p })).toEqual({ code: 0, out: '6.00' })
    // 6 ошибок на 101 запрос: клиент, закрывший соединение (499), — в знаменателе.
    const withAbort = log(6, 94, [line('/api/v1/integrations/telegram/dialogs', 499)])
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: withAbort })).toEqual({ code: 0, out: '5.94' })
  })

  it('меньше трёх ошибок за 5 минут — 0, ночной одиночный сбой не будит', () => {
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: log(2, 3) })).toEqual({ code: 0, out: '0.00' })
  })

  it('нет запросов к Telegram — 0', () => {
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: log(0, 0, [line('/', 200)]) })).toEqual({ code: 0, out: '0.00' })
  })

  it('всплеск 502 в одну-две минуты (стык двух замеров) — 0: нужны ошибки минимум в 3 разных минутах', () => {
    const burst = file(
      'burst.log',
      [
        ...Array.from({ length: 20 }, () => line('/api/v1/integrations/telegram/dialogs', 200, 3)),
        ...Array.from({ length: 10 }, (_, i) => line('/api/v1/integrations/telegram/dialogs/db-page', 502, 1 + (i % 2))),
      ].join('\n') + '\n',
    )
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: burst })).toEqual({ code: 0, out: '0.00' })
  })

  it('первые 8 минут после запуска backend или SM — 0: 502 деплоя не будят', () => {
    const p = log(30, 70)
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: p, FAKE_STARTED_AT: startedAgo(200) })).toEqual({ code: 0, out: '0.00' })
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: p, FAKE_STARTED_AT_SM: startedAgo(470) })).toEqual({ code: 0, out: '0.00' })
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: p, FAKE_STARTED_AT_SM: startedAgo(490) })).toEqual({ code: 0, out: '30.00' })
  })

  it('время запуска контейнера не прочитано — сбой, а не «только что запустился»', () => {
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: log(30, 70), FAKE_INSPECT_FAIL: '1' })).toEqual({ code: 1, out: '' })
  })

  it('журнал не прочитан — код ошибки и пустой вывод, а не 0', () => {
    expect(run('tg_api_5xx_pct', { FAKE_NGINX_LOG: log(6, 94), FAKE_DOCKER_FAIL: '1' })).toEqual({ code: 1, out: '' })
  })
})

describe('hrh-business.sh: метрики /metrics', () => {
  it('очередь распознавания — сумма серий meeting-stt', () => {
    const m = file(
      'backend.prom',
      [
        '# TYPE hr_helper_bullmq_waiting_total gauge',
        'hr_helper_bullmq_waiting_total{queue="meeting-stt",class="stt"} 7',
        'hr_helper_bullmq_waiting_total{queue="resume-parse",class="ai"} 40',
      ].join('\n'),
    )
    expect(run('stt_queue_waiting', { FAKE_METRICS_BACKEND: m })).toEqual({ code: 0, out: '7' })
  })

  it('нет серии meeting-stt (backend не достучался до Redis) — сбой чтения, а не пустая очередь', () => {
    const m = file('backend.prom', 'hr_helper_http_requests_total{method="GET",route="/x",status="200"} 5\n')
    expect(run('stt_queue_waiting', { FAKE_METRICS_BACKEND: m })).toEqual({ code: 1, out: '' })
  })

  it('очередь распознавания — waiting и prioritized: задачи с приоритетом BullMQ 5 держит отдельным списком', () => {
    const m = file(
      'backend.prom',
      [
        'hr_helper_bullmq_waiting_total{queue="meeting-stt",class="stt"} 2',
        'hr_helper_bullmq_prioritized_total{queue="meeting-stt",class="stt"} 5',
        'hr_helper_bullmq_prioritized_total{queue="resume-parse",class="ai"} 9',
      ].join('\n') + '\n',
    )
    expect(run('stt_queue_waiting', { FAKE_METRICS_BACKEND: m })).toEqual({ code: 0, out: '7' })
    // Одна серия prioritized без waiting — это не «backend прочитал очередь»: сбой чтения.
    const only = file('backend2.prom', 'hr_helper_bullmq_prioritized_total{queue="meeting-stt",class="stt"} 5\n')
    expect(run('stt_queue_waiting', { FAKE_METRICS_BACKEND: only })).toEqual({ code: 1, out: '' })
  })

  it('очередь стоит: ждут, а в работе ни одной — число ждущих; разбирается (active > 0) — 0; без серий — сбой', () => {
    const q = (waiting: number, prioritized: number | null, active: number | null) =>
      file(
        'backend.prom',
        [
          `hr_helper_bullmq_waiting_total{queue="meeting-stt",class="stt"} ${waiting}`,
          ...(prioritized === null ? [] : [`hr_helper_bullmq_prioritized_total{queue="meeting-stt",class="stt"} ${prioritized}`]),
          ...(active === null ? [] : [`hr_helper_bullmq_active_total{queue="meeting-stt",class="stt"} ${active}`]),
          'hr_helper_bullmq_waiting_total{queue="resume-parse",class="ai"} 50',
          'hr_helper_bullmq_active_total{queue="resume-parse",class="ai"} 0',
        ].join('\n') + '\n',
      )
    expect(run('stt_queue_stalled', { FAKE_METRICS_BACKEND: q(3, 2, 0) })).toEqual({ code: 0, out: '5' })
    expect(run('stt_queue_stalled', { FAKE_METRICS_BACKEND: q(500, 0, 1) })).toEqual({ code: 0, out: '0' })
    expect(run('stt_queue_stalled', { FAKE_METRICS_BACKEND: q(0, 0, 0) })).toEqual({ code: 0, out: '0' })
    // backend до 22.10: prioritized нет — считаем по waiting.
    expect(run('stt_queue_stalled', { FAKE_METRICS_BACKEND: q(4, null, 0) })).toEqual({ code: 0, out: '4' })
    expect(run('stt_queue_stalled', { FAKE_METRICS_BACKEND: q(4, 0, null) })).toEqual({ code: 1, out: '' })
    expect(run('stt_queue_stalled', { FAKE_DOCKER_FAIL: '1' })).toEqual({ code: 1, out: '' })
  })

  it('покрытие подписок — к живым клиентам пула SM, не выше 100 %', () => {
    const backend = (active: number[]) =>
      file('backend.prom', active.map((v, i) => `hr_helper_telegram_subscriptions_active{user_id="u${i}"} ${v}`).join('\n') + '\n')
    const sm = (pool: number) => file('sm.prom', `telegram_active_sessions{pod_id="local"} ${pool}\n`)
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend([1, 1, 1, 0]), FAKE_METRICS_SM: sm(4) })).toEqual({ code: 0, out: '75.0' })
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend([1, 1, 1]), FAKE_METRICS_SM: sm(2) })).toEqual({ code: 0, out: '100.0' })
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend([]), FAKE_METRICS_SM: sm(0) })).toEqual({ code: 0, out: '100.0' })
  })

  it('покрытие: нет серии пула SM — сбой; первые 12 минут после запуска backend — 100', () => {
    const backend = file('backend.prom', 'hr_helper_telegram_subscriptions_active{user_id="u1"} 0\n')
    const noPool = file('sm.prom', 'nodejs_heap_size_used_bytes 1\n')
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend, FAKE_METRICS_SM: noPool })).toEqual({ code: 1, out: '' })
    const pool = file('sm2.prom', 'telegram_active_sessions{pod_id="local"} 3\n')
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend, FAKE_METRICS_SM: pool, FAKE_STARTED_AT: startedAgo(300) })).toEqual({
      code: 0,
      out: '100',
    })
    expect(run('tg_subs_coverage_pct', { FAKE_METRICS_BACKEND: backend, FAKE_METRICS_SM: pool })).toEqual({ code: 0, out: '0.0' })
  })

  it('покрытие: docker не отвечает или время запуска не прочитано — сбой, а не 100', () => {
    expect(run('tg_subs_coverage_pct', { FAKE_DOCKER_FAIL: '1' })).toEqual({ code: 1, out: '' })
    expect(run('tg_subs_coverage_pct', { FAKE_INSPECT_FAIL: '1' })).toEqual({ code: 1, out: '' })
  })

  it('записи без задачи: uploaded старше 30 минут сверх задач waiting и delayed; очередь не прочитана — сбой', () => {
    const q = (waiting: number, delayed: number, active: number) =>
      file(
        'backend.prom',
        [
          `hr_helper_bullmq_waiting_total{queue="meeting-stt",class="stt"} ${waiting}`,
          `hr_helper_bullmq_delayed_total{queue="meeting-stt",class="stt"} ${delayed}`,
          `hr_helper_bullmq_active_total{queue="meeting-stt",class="stt"} ${active}`,
          'hr_helper_bullmq_waiting_total{queue="resume-parse",class="ai"} 50',
        ].join('\n') + '\n',
      )
    expect(run('stt_orphaned', { FAKE_METRICS_BACKEND: q(1, 1, 1), FAKE_PG_VALUE: '5' })).toEqual({ code: 0, out: '3' })
    // Задачи с приоритетом — тоже задачи: запись не «без задачи».
    const withPrio = file('backend3.prom', [
      'hr_helper_bullmq_waiting_total{queue="meeting-stt",class="stt"} 1',
      'hr_helper_bullmq_prioritized_total{queue="meeting-stt",class="stt"} 3',
      'hr_helper_bullmq_delayed_total{queue="meeting-stt",class="stt"} 0',
    ].join('\n') + '\n')
    expect(run('stt_orphaned', { FAKE_METRICS_BACKEND: withPrio, FAKE_PG_VALUE: '5' })).toEqual({ code: 0, out: '1' })
    expect(run('stt_orphaned', { FAKE_METRICS_BACKEND: q(4, 2, 0), FAKE_PG_VALUE: '5' })).toEqual({ code: 0, out: '0' })
    expect(readFileSync(join(dir, 'sql.log'), 'utf8')).toContain("status = 'uploaded' and updated_at < now() - interval '30 minutes'")
    const noQueue = file('backend2.prom', 'hr_helper_http_requests_total{method="GET",route="/x",status="200"} 1\n')
    expect(run('stt_orphaned', { FAKE_METRICS_BACKEND: noQueue, FAKE_PG_VALUE: '5' })).toEqual({ code: 1, out: '' })
  })

  it('выселения сессий — сумма приростов за последний час; сброс счётчика и отсутствие серии не дают минуса', () => {
    const sm = (v: number | null) =>
      file('sm.prom', v === null ? 'telegram_active_sessions{pod_id="local"} 1\n' : `telegram_session_evictions_total{pod_id="local"} ${v}\n`)
    const state = join(dir, 'state', 'tg_evictions')
    expect(run('tg_evictions_1h', { FAKE_METRICS_SM: sm(10) })).toEqual({ code: 0, out: '0' })
    expect(readFileSync(state, 'utf8').trim().split(' ')[1]).toBe('10')

    const history = (rows: Array<[number, number]>) =>
      writeFileSync(state, rows.map(([ago, v]) => `${Math.floor(Date.now() / 1000) - ago} ${v}`).join('\n') + '\n')
    // Замер старше 65 минут выпадает; приросты 100→110→125 — 25 за час.
    history([[4000, 0], [3000, 100], [1500, 110]])
    expect(run('tg_evictions_1h', { FAKE_METRICS_SM: sm(125) })).toEqual({ code: 0, out: '25' })
    expect(readFileSync(state, 'utf8').trim().split('\n')).toHaveLength(3)
    history([[1800, 10]])
    expect(run('tg_evictions_1h', { FAKE_METRICS_SM: sm(5) })).toEqual({ code: 0, out: '5' })
    history([[1800, 10]])
    expect(run('tg_evictions_1h', { FAKE_METRICS_SM: sm(null) })).toEqual({ code: 0, out: '0' })
  })

  it('Redis очередей: used_memory в % от maxmemory; maxmemory не задан или контейнера нет — сбой, а не 0', () => {
    // redis-cli отдаёт строки с \r\n; used_memory_human и maxmemory_policy не должны попасть в расчёт.
    const info = (max: number) =>
      file(
        'redis.info',
        ['# Memory', 'used_memory:201326592', 'used_memory_human:192.00M', `maxmemory:${max}`, 'maxmemory_human:256.00M', 'maxmemory_policy:noeviction', ''].join('\r\n'),
      )
    expect(run('redis_queue_mem_pct', { FAKE_REDIS_INFO: info(268435456) })).toEqual({ code: 0, out: '75.0' })
    expect(run('redis_queue_mem_pct', { FAKE_REDIS_INFO: info(0) })).toEqual({ code: 1, out: '' })
    expect(run('redis_queue_mem_pct')).toEqual({ code: 1, out: '' })
  })

  it('незнакомый ключ — код 2', () => {
    expect(run('nope').code).toBe(2)
  })
})

describe('hrh-business.sh: разметка говорящих', () => {
  it('готовые записи с пометкой разметки за час — по тем префиксам, что пишет backend (meeting-stt.constants.ts)', () => {
    expect(run('stt_diarization_failed_1h', { FAKE_PG_VALUE: '2' })).toEqual({ code: 0, out: '2' })
    const sql = readFileSync(join(dir, 'sql.log'), 'utf8')
    expect(sql).toContain("status = 'ready'")
    expect(sql).toContain("error_text like 'Разметка говорящих не выполнена%'")
    expect(sql).toContain("error_text like 'Повторная диаризация%'")
    expect(sql).toContain("updated_at > now() - interval '1 hour'")
  })
})
