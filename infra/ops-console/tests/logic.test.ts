import { describe, expect, it, vi } from 'vitest'
import { isContainerDown, isExpectedExit, isStateful, restartDelta } from '../server/alerts/container-state'
import { isAgentSilent, silenceSuppressed } from '../server/agents/silence'
import { evaluateResponse } from '../server/monitors/checks'
import { overallStatus, recommendations } from '../server/reports/build'
import { reportPeriodKey } from '../server/scheduler/tick'
import { decryptJson, encryptJson, hashPassword, verifyPassword } from '../server/lib/crypto'
import { assertSafeUrl, classifyAddress, httpRequest, resolveTarget } from '../server/lib/http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extractHostSamples } from '../server/agents/samples'
import { agentReportSchema } from '../shared/agent-contract'
import { splitActivity } from '../web/ui/ActivityText'
import { readFileSync } from 'node:fs'
import { BUILTIN_RULES } from '../server/alerts/builtin'
import { bizSubsystem, isMeasuredBizMetric, metricHint, metricLabel } from '../server/alerts/explain'
import { bizStreakText } from '../shared/alert-streak'
import { isNewBusinessSample, newOomKills } from '../server/agents/ingest'

describe('состояние контейнера', () => {
  it('одноразовая задача с кодом 0 — не авария, сервис с unless-stopped — авария', () => {
    expect(isExpectedExit('no', 0)).toBe(true)
    expect(isContainerDown({ state: 'exited', restartPolicy: 'no', exitCode: 0 })).toBe(false)
    expect(isContainerDown({ state: 'exited', restartPolicy: 'unless-stopped', exitCode: 0 })).toBe(true)
    expect(isContainerDown({ state: 'exited', restartPolicy: '', exitCode: 137 })).toBe(true)
    expect(isContainerDown({ state: 'restarting', restartPolicy: 'always', exitCode: null })).toBe(true)
    expect(isContainerDown({ state: 'running', restartPolicy: 'always', exitCode: null })).toBe(false)
  })

  it('stateful: метка агента приоритетнее эвристики', () => {
    expect(isStateful({ name: 'backend-postgres-1', image: 'postgres:16', composeService: 'postgres' })).toBe(true)
    expect(isStateful({ name: 'hr-redis', image: 'redis:7', composeService: '' })).toBe(true)
    expect(isStateful({ name: 'backend-backend-1', image: 'hr/backend', composeService: 'backend' })).toBe(false)
    expect(isStateful({ name: 'backend-backend-1', image: 'hr/backend', composeService: 'backend', stateful: true })).toBe(true)
    expect(isStateful({ name: 'my-postgres-exporter', image: 'x', composeService: '', stateful: false })).toBe(false)
  })

  it('прирост перезапусков учитывает сброс счётчика', () => {
    expect(restartDelta(7, 2, 3)).toBe(5)
    expect(restartDelta(7, null, 4)).toBe(3)
    expect(restartDelta(1, 9, null)).toBe(1)
    expect(restartDelta(5, null, null)).toBe(0)
  })
})

describe('агент молчит', () => {
  it('ни разу не отчитавшийся агент — не авария', () => {
    expect(isAgentSilent(null, 15, 4)).toBe(false)
    const now = Date.now()
    expect(isAgentSilent(new Date(now - 59_000), 15, 4, now)).toBe(false)
    expect(isAgentSilent(new Date(now - 61_000), 15, 4, now)).toBe(true)
  })

  it('после рестарта консоли старая тишина не оценивается, пока агент не успел вернуться', () => {
    const up = 1_000_000
    // агент молчал с момента до старта консоли: окно 60 с + пауза агента 60 с
    expect(silenceSuppressed(up - 300_000, up, 60_000, up + 30_000)).toBe(true)
    expect(silenceSuppressed(up - 300_000, up, 60_000, up + 121_000)).toBe(false)
    // отчитался уже после старта — обычная оценка
    expect(silenceSuppressed(up + 5_000, up, 60_000, up + 30_000)).toBe(false)
    // на Vercel отметки старта нет
    expect(silenceSuppressed(up - 300_000, 0, 60_000, up)).toBe(false)
  })
})

describe('проверки доступности', () => {
  const m = { expectStatus: null, expectHealthJson: false, keyword: null }
  it('статус, health-JSON и ключевая строка', () => {
    expect(evaluateResponse(m, 200, '')).toBeNull()
    expect(evaluateResponse(m, 301, '')).toBeNull()
    expect(evaluateResponse(m, 502, '')).toBe('HTTP 502')
    expect(evaluateResponse({ ...m, expectStatus: 204 }, 200, '')).toBe('HTTP 200')
    expect(evaluateResponse({ ...m, expectHealthJson: true }, 200, '{"status":"ok"}')).toBeNull()
    expect(evaluateResponse({ ...m, expectHealthJson: true }, 200, '{"status":"degraded"}')).toContain('degraded')
    expect(evaluateResponse({ ...m, expectHealthJson: true }, 200, '<html>')).toContain('не JSON')
    expect(evaluateResponse({ ...m, keyword: 'HR Helper' }, 200, '<title>HR Helper</title>')).toBeNull()
    expect(evaluateResponse({ ...m, keyword: 'HR Helper' }, 200, 'nginx default')).toContain('нет ключевой')
  })

  it('URL: только http(s), без учётных данных', () => {
    expect(() => assertSafeUrl('https://app.hrhelper.space/')).not.toThrow()
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow()
    expect(() => assertSafeUrl('https://user:pass@example.com')).toThrow()
  })
})

describe('отчёт ИИ-совету', () => {
  it('общий статус', () => {
    expect(overallStatus({ criticalOpen: 0, warningOpen: 0, minUptime: 99.95 })).toBe('healthy')
    expect(overallStatus({ criticalOpen: 0, warningOpen: 1, minUptime: 100 })).toBe('degraded')
    expect(overallStatus({ criticalOpen: 0, warningOpen: 0, minUptime: 99.5 })).toBe('degraded')
    expect(overallStatus({ criticalOpen: 1, warningOpen: 0, minUptime: 100 })).toBe('critical')
    expect(overallStatus({ criticalOpen: 0, warningOpen: 0, minUptime: 98 })).toBe('critical')
    // Открытый инцидент без горящих алертов (заведён вручную / алерты уже закрылись) — не «штатно».
    expect(overallStatus({ criticalOpen: 0, warningOpen: 0, minUptime: 100, activeCriticalIncidents: 1, unresolvedIncidents: 1 })).toBe(
      'critical',
    )
    expect(overallStatus({ criticalOpen: 0, warningOpen: 0, minUptime: 100, unresolvedIncidents: 1 })).toBe('degraded')
  })

  it('рекомендации по фактам', () => {
    const recs = recommendations({
      hosts: [
        { agent: 'a', name: 'main-vps', cpuAvgPct: 20, cpuMaxPct: 50, memAvgPct: 90, diskMaxPct: 88, containersNotRunning: ['worker'] },
      ],
      restarts: [
        { agent: 'a', container: 'backend', at: '', by: '', reason: '', result: 'succeeded' },
        { agent: 'a', container: 'backend', at: '', by: '', reason: '', result: 'succeeded' },
      ],
      availability: [{ monitor: 'SPA', url: '', uptimePct: 99.1, checks: 100, avgLatencyMs: 200 }],
      tls: [{ domain: 'hrhrm-v2.com', daysLeft: 9, error: null }],
      deploys: { total: 2, failed: 1, recent: [] },
    })
    expect(recs.join('\n')).toMatch(/диск заполнен до 88/)
    expect(recs.join('\n')).toMatch(/backend перезапускали вручную 2/)
    expect(recs.join('\n')).toMatch(/hrhrm-v2.com истекает через 9/)
    expect(recs.join('\n')).toMatch(/Упавших деплоев/)
  })

  it('ключ периода: сутки и ISO-неделя', () => {
    expect(reportPeriodKey('daily', new Date('2026-10-07T06:10:00Z'))).toBe('daily:2026-10-07')
    expect(reportPeriodKey('weekly', new Date('2026-10-05T06:00:00Z'))).toBe('weekly:2026-W41')
    expect(reportPeriodKey('weekly', new Date('2027-01-01T06:00:00Z'))).toBe('weekly:2026-W53')
  })
})

describe('крипто', () => {
  it('шифрование секретов и пароли', async () => {
    const enc = encryptJson({ botToken: '123:abc' })
    expect(enc).not.toContain('123:abc')
    expect(decryptJson(enc)).toEqual({ botToken: '123:abc' })
    const hash = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
})

describe('контракт агента', () => {
  it('метрики хоста: диск — максимум по точкам монтирования', () => {
    const r = agentReportSchema.parse({
      agentVersion: '1',
      memory: { totalMb: 1000, usedMb: 250 },
      disks: [
        { mount: '/', totalGb: 100, usedGb: 50 },
        { mount: '/data', totalGb: 100, usedGb: 91 },
      ],
      business: { db_size_mb: 512 },
    })
    const s = extractHostSamples(r)
    expect(s.get('mem_pct')).toBe(25)
    expect(s.get('disk_pct')).toBe(91)
    expect(s.get('biz_db_size_mb')).toBe(512)
    expect(s.has('docker_ok')).toBe(false)
  })

  it('docker_ok: 1 — docker ответил, 0 — агент прислал dockerError', () => {
    expect(extractHostSamples(agentReportSchema.parse({ agentVersion: '1', containers: [] })).get('docker_ok')).toBe(1)
    expect(extractHostSamples(agentReportSchema.parse({ agentVersion: '1', dockerError: 'docker CLI не отвечает' })).get('docker_ok')).toBe(
      0,
    )
  })
})

describe('лента событий', () => {
  it('эмодзи-метка сервера превращается в точку статуса, текст — без неё', () => {
    expect(splitActivity('🔴 Сайт недоступен — app')).toEqual({ lead: ['Критично', 'var(--st-critical)'], text: 'Сайт недоступен — app' })
    expect(splitActivity('✅ Перезапуск api выполнен')).toMatchObject({ lead: ['Успешно', 'var(--st-healthy)'] })
    expect(splitActivity('Вход: owner@ops.local')).toEqual({ lead: null, text: 'Вход: owner@ops.local' })
  })
})

describe('исходящие запросы: защита от SSRF', () => {
  it('классификация адресов', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(classifyAddress(ip)).toBe('public')
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a00:1',
    ])
      expect(classifyAddress(ip)).toBe('private')
    for (const ip of ['169.254.169.254', '0.0.0.0', 'fe80::1', '::', '224.0.0.1', '::ffff:169.254.169.254'])
      expect(classifyAddress(ip)).toBe('blocked')
  })

  it('внутренний адрес — только по списку владельца; метаданные облака — никогда', async () => {
    await expect(resolveTarget(new URL('http://127.0.0.1:3001/'))).rejects.toThrow(/внутренний адрес/)
    await expect(resolveTarget(new URL('http://localhost/'))).rejects.toThrow(/внутренний адрес/)
    await expect(resolveTarget(new URL('http://127.0.0.1/'), ['127.0.0.1'])).resolves.toMatchObject({ address: '127.0.0.1' })
    await expect(resolveTarget(new URL('http://169.254.169.254/latest/meta-data/'), ['169.254.169.254'])).rejects.toThrow(/запрещён/)
    await expect(resolveTarget(new URL('http://[::ffff:10.0.0.1]/'))).rejects.toThrow(/внутренний адрес/)
  })

  it('редирект на внутренний адрес проверяется заново и отклоняется', async () => {
    const srv = createServer((req, res) => {
      if (req.url === '/to-metadata') res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }).end()
      else if (req.url === '/to-self') res.writeHead(302, { Location: '/ok' }).end()
      else res.writeHead(200).end('ok')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    try {
      const allow = ['127.0.0.1']
      await expect(httpRequest(`${base}/to-metadata`, { followRedirects: true, allowPrivateHosts: allow })).rejects.toThrow(/запрещён/)
      const ok = await httpRequest(`${base}/to-self`, { followRedirects: true, allowPrivateHosts: allow })
      expect(ok).toMatchObject({ status: 200, text: 'ok' })
      // Без следования редиректам — ответ 302 как есть, цель редиректа не запрашивается.
      expect((await httpRequest(`${base}/to-metadata`, { allowPrivateHosts: allow })).status).toBe(302)
      await expect(httpRequest(`${base}/to-self`)).rejects.toThrow(/внутренний адрес/)
    } finally {
      srv.close()
    }
  })
})

describe('деплои GitHub', () => {
  it('история не шлёт алертов; свежий запуск без шагов — «не запустился»', async () => {
    const { freshApp } = await import('./helpers')
    await freshApp()
    const { pollGithubDeploys } = await import('../server/deploys/github')
    const { writeSetting } = await import('../server/settings/store')
    const { getDb } = await import('../server/db/client')
    await writeSetting('github', { repo: 'acme/app', workflow: 'deploy.yml', tokenEnc: null })
    const now = Date.now()
    const runs = [
      {
        id: 3,
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'c3',
        display_title: 'свежий, не запустился',
        html_url: '',
        updated_at: new Date(now - 60_000).toISOString(),
      },
      {
        id: 2,
        status: 'completed',
        conclusion: 'success',
        head_sha: 'c2',
        display_title: 'старый успех',
        html_url: '',
        updated_at: new Date(now - 5 * 86_400_000).toISOString(),
      },
      {
        id: 1,
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'c1',
        display_title: 'старое падение',
        html_url: '',
        updated_at: new Date(now - 6 * 86_400_000).toISOString(),
      },
    ]
    const http = await import('../server/lib/http')
    const spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url: string) => {
      // Запуск 1 — настоящее падение (шаги были), запуск 3 — GitHub не стартовал задачу.
      const jobs = url.includes('/runs/1/jobs') ? [{ steps: [{ name: 'build', conclusion: 'failure' }] }] : [{ steps: [] }]
      const text = url.includes('/jobs') ? JSON.stringify({ jobs }) : JSON.stringify({ workflow_runs: runs })
      return { status: 200, ok: true, text, latencyMs: 1 }
    })
    try {
      expect(await pollGithubDeploys()).toBe('ok')
    } finally {
      spy.mockRestore()
    }
    const rows = await getDb().query.deploys.findMany()
    expect(Object.fromEntries(rows.map((r) => [r.runKey, r.conclusion]))).toEqual({ '1': 'failure', '2': 'success', '3': 'not_started' })
    const alerts = await getDb().query.alerts.findMany()
    expect(alerts.map((a) => a.title)).toEqual(['Деплой не запустился'])
    const feed = await getDb().query.activity.findMany()
    expect(feed.filter((e) => e.kind === 'deploy').map((e) => e.message)).toEqual(['🔴 Деплой не запустился — свежий, не запустился'])
  })

  /** Запуск GitHub Actions в форме API: шаги — [имя, итог]. */
  async function pollWith(runs: Array<Record<string, unknown>>, steps: Record<string, Array<[string, string]>>) {
    const { pollGithubDeploys } = await import('../server/deploys/github')
    const http = await import('../server/lib/http')
    const spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url: string) => {
      const id = /\/runs\/(\d+)\/jobs/.exec(url)?.[1]
      const jobs = [{ name: 'deploy', steps: (steps[id ?? ''] ?? []).map(([name, conclusion]) => ({ name, conclusion })) }]
      const text = id ? JSON.stringify({ jobs }) : JSON.stringify({ workflow_runs: runs })
      return { status: 200, ok: true, text, latencyMs: 1 }
    })
    try {
      expect(await pollGithubDeploys()).toBe('ok')
    } finally {
      spy.mockRestore()
    }
  }

  const deployRun = (id: number, conclusion: string, title: string, minutesAgo: number) => ({
    id,
    status: 'completed',
    conclusion,
    head_sha: `sha${id}`,
    display_title: title,
    html_url: `https://github.com/acme/app/actions/runs/${id}`,
    run_started_at: new Date(Date.now() - (minutesAgo + 20) * 60_000).toISOString(),
    updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  })

  it('упала проверка после выката — «новая версия выкачена» и имя шага; следующий успех закрывает алерт', async () => {
    const { freshApp } = await import('./helpers')
    await freshApp()
    const { writeSetting } = await import('../server/settings/store')
    const { getDb } = await import('../server/db/client')
    await writeSetting('github', { repo: 'acme/app', workflow: 'deploy.yml', tokenEnc: null })
    const failedCheck = deployRun(7, 'failure', 'Merge PR #87', 2)
    await pollWith([failedCheck], {
      '7': [
        ['Set up job', 'success'],
        ['Деплой на VPS', 'success'],
        ['Проверка снаружи', 'failure'],
        ['Complete job', 'success'],
      ],
    })
    const [alert] = await getDb().query.alerts.findMany()
    expect(alert?.title).toBe('Проверка после деплоя не прошла')
    expect(alert?.value).toBe('упал шаг «Проверка снаружи» — Merge PR #87')
    const facts = JSON.parse(alert?.factsJson ?? '[]') as Array<[string, string]>
    expect(facts).toContainEqual(['Упавший шаг', 'Проверка снаружи'])
    expect(facts).toContainEqual(['Прод', 'новая версия выкачена'])
    expect(alert?.hint).toMatch(/Новая версия уже выкачена \(шаг «Деплой на VPS» прошёл\)/)
    expect(alert?.hint).not.toMatch(/предыдущей версии/)
    const feed = await getDb().query.activity.findMany()
    expect(feed.filter((e) => e.kind === 'deploy').map((e) => e.message)).toEqual(['🟠 Выкачен, но не прошла проверка — Merge PR #87'])

    await pollWith([deployRun(8, 'success', 'fix: проверка с повторами', 0), failedCheck], {})
    const after = await getDb().query.alerts.findFirst()
    expect(after?.status).toBe('resolved')
    expect(after?.resolution).toMatch(/следующий деплой успешен/)
  })

  it('упало до выката — «прод на предыдущей версии»; упал сам шаг деплоя — «могла обновиться часть»', async () => {
    const { freshApp } = await import('./helpers')
    await freshApp()
    const { writeSetting } = await import('../server/settings/store')
    const { getDb } = await import('../server/db/client')
    await writeSetting('github', { repo: 'acme/app', workflow: 'deploy.yml', tokenEnc: null })
    await pollWith([deployRun(11, 'failure', 'нет секрета', 1)], {
      '11': [
        ['Set up job', 'success'],
        ['Проверка секретов', 'failure'],
        ['Деплой на VPS', 'skipped'],
      ],
    })
    const [first] = await getDb().query.alerts.findMany()
    expect(first?.title).toBe('Деплой упал')
    expect(first?.hint).toMatch(/Упал шаг «Проверка секретов» — до выката дело не дошло, прод на предыдущей версии/)

    await pollWith([deployRun(12, 'failure', 'сборка упала', 0), deployRun(11, 'failure', 'нет секрета', 1)], {
      '12': [
        ['Set up job', 'success'],
        ['Деплой на VPS', 'failure'],
      ],
    })
    const [again] = await getDb().query.alerts.findMany()
    expect(again?.hint).toMatch(/Упал сам шаг деплоя «Деплой на VPS»: часть сервисов могла уже обновиться/)
  })
})

describe('доступ по имени хоста', () => {
  it('allowlist: только свои имена и loopback; пустой список — без ограничений', async () => {
    const { hostAllowed } = await import('../server/http-types')
    const allowed = ['ops.admin.hrhelper.space']
    expect(hostAllowed('ops.admin.hrhelper.space', allowed)).toBe(true)
    expect(hostAllowed('127.0.0.1', allowed)).toBe(true)
    expect(hostAllowed('localhost', allowed)).toBe(true)
    expect(hostAllowed('173.212.238.170', allowed)).toBe(false)
    expect(hostAllowed('app.hrhelper.space', allowed)).toBe(false)
    expect(hostAllowed('evil.example', [])).toBe(true)
  })
})

describe('P0: правила по бизнес-метрикам', () => {
  it('порог в замерах и новый замер — по времени замера из отчёта', () => {
    expect(bizStreakText(2)).toBe(', 2 замера подряд')
    expect(bizStreakText(4)).toBe(', 4 замера подряд')
    expect(bizStreakText(1)).toBe('')
    expect(isNewBusinessSample(null, { businessAt: 5 })).toBe(true)
    expect(isNewBusinessSample('{"businessAt":5}', { businessAt: 5 })).toBe(false)
    expect(isNewBusinessSample('{"businessAt":4}', { businessAt: 5 })).toBe(true)
    expect(isNewBusinessSample('{"businessAt":5}', {})).toBe(false)
    expect(isNewBusinessSample('не json', { businessAt: 5 })).toBe(true)
  })

  it('объект алерта — подсистема P0; замеры — только у метрик P0', () => {
    expect(bizSubsystem('biz_stt_stuck')).toBe('STT')
    expect(bizSubsystem('biz_tg_api_5xx_pct')).toBe('Telegram')
    expect(bizSubsystem('biz_hf_refresh_rejected')).toBe('Huntflow')
    expect(bizSubsystem('biz_failed')).toBeNull()
    expect(bizSubsystem('cpu_pct')).toBeNull()
    expect(isMeasuredBizMetric('biz_stt_failed_1h')).toBe(true)
    expect(bizSubsystem('biz_stt_diarization_failed_1h')).toBe('STT')
    expect(isMeasuredBizMetric('biz_companies')).toBe(false)
  })

  it('упавшие команды — метрика biz_failed', () => {
    const r = agentReportSchema.parse({
      agentVersion: '1.3.0',
      intervalSec: 15,
      business: { companies: 3 },
      businessAt: 1_800_000_000,
      businessFailed: ['stt_stuck', 'tg_api_5xx_pct'],
    })
    const s = extractHostSamples(r)
    expect(s.get('biz_failed')).toBe(2)
    expect(s.get('biz_companies')).toBe(3)
  })

  it('каждое правило P0 считает метрику, которую печатает hrh-business.sh, и объясняет, что делать', () => {
    const script = readFileSync(new URL('../agent/hrh-business.sh', import.meta.url), 'utf8')
    // Ветки case: «  ключ)» или «  ключ1 | ключ2)».
    const keys = new Set([...script.matchAll(/^ {2}([a-z0-9_]+(?: \| [a-z0-9_]+)*)\)/gm)].flatMap((m) => m[1]!.split(' | ')))
    expect(keys.has('hf_refresh_rejected') && keys.has('hf_refresh_errors_6h')).toBe(true)
    const p0 = BUILTIN_RULES.filter((r) => r.metric?.startsWith('biz_'))
    expect(p0).toHaveLength(15)
    const since: Record<string, number> = { biz_redis_queue_mem_pct: 4, biz_stt_diarization_failed_1h: 6 }
    for (const r of p0) {
      const metric = r.metric ?? ''
      // v3 — P0 (STT, Telegram, Huntflow); v4 — Redis очередей; v6 — разметка говорящих.
      expect(r.since).toBe(since[metric] ?? 3)
      if (metric !== 'biz_failed') expect(keys.has(metric.slice('biz_'.length))).toBe(true)
      expect(metricLabel(metric)).not.toBe(metric)
      expect(metricHint(metric)).not.toBe('')
    }
  })
})

describe('нехватка памяти в контейнере', () => {
  it('сколько процессов убито с прошлого отчёта: точка отсчёта, прирост; итог меньше прошлого — новая точка отсчёта', () => {
    expect(newOomKills(undefined, { oomKills: 4 })).toBe(0)
    expect(newOomKills({ oomKills: null }, { oomKills: 4 })).toBe(0)
    expect(newOomKills({ oomKills: 4 }, { oomKills: 6 })).toBe(2)
    expect(newOomKills({ oomKills: 4 }, { oomKills: 4 })).toBe(0)
    // Итог агента по журналу ядра растёт и при перезапуске контейнера. Меньше прошлого — контейнер пересоздан
    // (новый id) или агент потерял учёт: это не «убито», а новая точка отсчёта.
    expect(newOomKills({ oomKills: 4 }, { oomKills: 1 })).toBe(0)
    expect(newOomKills({ oomKills: 4 }, { oomKills: null })).toBe(0)
  })
})
