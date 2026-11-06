// Колонка «Связь» на /deploys: пункты очереди владельца, связанные с деплоем, — правила связи (свой PR у мёржа, номер
// в заголовке или ссылке своего репозитория, текст — только у пунктов о ≤ 3 PR и ≤ 3 коммитах, короткий SHA; ручной
// запуск — не по коммиту), выполненность по ответу, открытые первыми, мёрж из очереди по merge-коммиту (журнал читается
// с курсора, битая запись не роняет страницу), только роль owner, сброс индекса при записи в очередь.
import { beforeEach, describe, expect, it } from 'vitest'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { deploys, oqEvents, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import { importDoc, logEvent } from '../server/queue/store'
import { LINKS_PER_DEPLOY, deployPrs, isLinked, itemRefs } from '../server/deploys/queue-links'

const linked = (d: Record<string, unknown>, prs: number[], sha = '') => isLinked(itemRefs('x', d), prs, sha)

describe('правила связи', () => {
  it('номер PR деплоя — из merge-коммита или «(#N)» squash-коммита', () => {
    expect(deployPrs('Merge pull request #408 from agolubenk/fix/queue-host-stays')).toEqual([408])
    expect(deployPrs('fix(ops): ссылка на очередь (#411)')).toEqual([411])
    expect(deployPrs('ручной запуск')).toEqual([])
    expect(deployPrs('Merge branch main, см. #12')).toEqual([])
  })

  it('мёрж — только свой PR: «после #404» в заголовке соседнего мёржа — не связь', () => {
    expect(linked({ kind: 'merge', title: 'Влить #405 после #404', pr: 405 }, [404])).toBe(false)
    expect(linked({ kind: 'merge', title: 'Влить #405 после #404', pr: 405 }, [405])).toBe(true)
    expect(linked({ kind: 'merge', title: 'Влить #405 после #404' }, [405])).toBe(true)
    expect(linked({ kind: 'merge', title: 'Влить #405', body: 'после #404 и abc123def456', pr: 405 }, [404], 'abc123def456')).toBe(false)
    // Номер — как у мёржа из очереди: из команды «gh pr merge N», а не из «после #404» в заголовке.
    expect(linked({ kind: 'merge', title: 'Влить после #404', cmd: 'gh pr merge 405 --merge' }, [404])).toBe(false)
    expect(linked({ kind: 'merge', title: 'Влить после #404', cmd: 'gh pr merge 405 --merge' }, [405])).toBe(true)
  })

  it('остальные — номер в поле pr, в заголовке или в ссылке на PR', () => {
    expect(linked({ kind: 'check', title: 'Проверить вход после #404' }, [404])).toBe(true)
    expect(linked({ kind: 'check', title: 'Проверить вход после #4040' }, [404])).toBe(false)
    expect(linked({ kind: 'decision', title: 'Политика', pr: 404 }, [404])).toBe(true)
    expect(linked({ kind: 'server', title: 'Шаг', links: [{ href: 'https://github.com/o/r/pull/404', text: 'PR' }] }, [404])).toBe(true)
  })

  it('ссылка на PR чужого репозитория — не связь, когда свой репозиторий настроен', () => {
    const item = { kind: 'check', title: 'Сверить', links: [{ href: 'https://github.com/other/lib/pull/404', text: 'upstream' }] }
    expect(isLinked(itemRefs('x', item, 'o/r'), [404], '')).toBe(false)
    expect(isLinked(itemRefs('x', { ...item, links: [{ href: 'https://github.com/o/r/pull/404' }] }, 'o/r'), [404], '')).toBe(true)
    expect(isLinked(itemRefs('x', item), [404], '')).toBe(true)
  })

  it('текст — только у пунктов о ≤ 3 PR; обзор на десятки PR — не связь; «&#8212;» — не номер', () => {
    expect(linked({ kind: 'check', title: 'Биллинг Actions', body: 'После #404, #405 и #406' }, [405])).toBe(true)
    expect(linked({ kind: 'decision', title: 'Режим ревью', body: '#401 #402 #403 #404 #405' }, [404])).toBe(false)
    expect(itemRefs('x', { kind: 'check', title: 't', body: 'тире &#8212; здесь' }).textPrs.size).toBe(0)
  })

  it('короткий SHA выкаченного коммита в тексте (от 7 знаков, с цифрой)', () => {
    expect(linked({ kind: 'check', title: 'Проверить после 98be5da3f' }, [], '98be5da3f1a2')).toBe(true)
    expect(linked({ kind: 'check', title: 'Проверить после 98be5d' }, [], '98be5da3f1a2')).toBe(false)
    expect(linked({ kind: 'check', title: 'defaced' }, [], 'defaced12345')).toBe(false)
    expect(linked({ kind: 'check', title: `полный ${'98be5da3f1a2'.padEnd(40, '0')}` }, [], '98be5da3f1a2')).toBe(true)
    // Обзор на много коммитов — как обзор на много PR: не связь.
    expect(linked({ kind: 'check', title: 'Сверка', body: '98be5da3f 1111aaa 2222bbb 3333ccc' }, [], '98be5da3f1a2')).toBe(false)
  })
})

describe('GET /events/deploys — поле queue', () => {
  let app: Awaited<ReturnType<typeof freshApp>>
  beforeEach(async () => {
    app = await freshApp()
    await getDb()
      .insert(users)
      .values({ email: 'view@ops.test', name: 'Вика', role: 'viewer', passwordHash: await hashPassword('view-password-123'), createdAt: new Date() })
    const t = Date.now()
    await getDb()
      .insert(deploys)
      .values([
        { runKey: '1', workflow: 'deploy-contabo.yml', status: 'completed', conclusion: 'success', headSha: 'aaaa1111bbbb', title: 'Merge pull request #404 from o/x', createdAt: new Date(t - 3_600_000) },
        { runKey: '2', workflow: 'deploy-contabo.yml', status: 'completed', conclusion: 'success', headSha: 'cccc2222dddd', title: 'ручной запуск', createdAt: new Date(t - 1_800_000) },
        { runKey: '3', workflow: 'deploy-contabo.yml', status: 'completed', conclusion: 'success', headSha: 'eeee3333ffff', title: 'Merge pull request #500 from o/y', createdAt: new Date(t) },
        { runKey: '4', workflow: 'deploy-contabo.yml', status: 'completed', conclusion: 'success', headSha: '5555aaaa6666', title: 'fix: хотфикс прямо в main', createdAt: new Date(t - 600_000) },
      ])
    const opts = [{ id: 'yes', label: 'Да' }]
    for (const [id, data] of [
      ['m-404', { kind: 'merge', title: 'Влить #404', pr: 404 }],
      ['m-405', { kind: 'merge', title: 'Влить #405 после #404', pr: 405 }],
      ['c-404-login', { kind: 'check', title: 'Проверить вход после #404' }],
      ['d-404-policy', { kind: 'decision', title: 'Политика входа', body: 'Касается #404', options: opts }],
      ['d-overview', { kind: 'decision', title: 'Обзор', body: '#401 #402 #403 #404 #405', options: opts }],
      ['s-404-old', { kind: 'server', title: 'Старый шаг #404', archived: true }],
      ['m-hotfix', { kind: 'merge', title: 'Влить хотфикс' }],
      // headSha ручного запуска — вершина main, не выкаченный коммит: откат не должен показывать этот пункт.
      ['c-tip', { kind: 'check', title: 'Проверить после cccc2222dddd' }],
    ] as const)
      expect(await importDoc('items', id, data as Record<string, unknown>, 'test')).toBe('added')
    await importDoc('checks', 'c-404-login', { done: true, at: new Date().toISOString() }, 'test')
    await logEvent('console:owner@ops.test', 'items', 'm-hotfix', 'merge', { pr: 7, sha: 'f'.repeat(40), mergeSha: `5555aaaa6666${'0'.repeat(28)}`, skipCi: false }, 'hr-helper')
    await logEvent('console:owner@ops.test', 'items', 'm-404', 'merge', { pr: 404, sha: 'f'.repeat(40), mergeSha: `cccc2222dddd${'0'.repeat(28)}`, skipCi: false }, 'hr-helper')
  })

  const byRun = (list: Array<Record<string, any>>, runKey: string) => list.find((d) => d.runKey === runKey)!

  it('владельцу — связанные пункты по одному, открытые первыми, выполненные отмечены; архивные и обзорные — нет', async () => {
    const list = (await api(app, await login(app)).get('/events/deploys')).json.deploys
    expect(byRun(list, '1').queue).toEqual({
      links: [
        { id: 'm-404', kind: 'merge', title: 'Влить #404', done: false },
        { id: 'd-404-policy', kind: 'decision', title: 'Политика входа', done: false },
        { id: 'c-404-login', kind: 'check', title: 'Проверить вход после #404', done: true },
      ],
      more: 0,
    })
    // Ручной запуск (в т.ч. откат) — ни по коммиту, ни по событию «Влить» с этим коммитом.
    expect(byRun(list, '2').queue).toBeNull()
    expect(byRun(list, '3').queue).toBeNull()
    // Коммит без номера PR, влитый из очереди: связь — по merge-коммиту события «Влить».
    expect(byRun(list, '4').queue.links.map((l: { id: string }) => l.id)).toEqual(['m-hotfix'])
  })

  it('журнал мёржей дочитывается с курсора; битая запись не роняет страницу', async () => {
    const owner = api(app, await login(app))
    expect(byRun((await owner.get('/events/deploys')).json.deploys, '3').queue).toBeNull()
    await getDb().insert(oqEvents).values({ actor: 'test', collection: 'items', docId: 'm-404', action: 'merge', afterJson: '{"mergeSha":"eeee3333' })
    await importDoc('items', 'm-500', { kind: 'merge', title: 'Влить хотфикс 2' }, 'test')
    await logEvent('test', 'items', 'm-500', 'merge', { pr: 9, sha: 'f'.repeat(40), mergeSha: `eeee3333ffff${'0'.repeat(28)}`, skipCi: false }, 'hr-helper')
    const res = await owner.get('/events/deploys')
    expect(res.status).toBe(200)
    expect(byRun(res.json.deploys, '3').queue.links.map((l: { id: string }) => l.id)).toEqual(['m-500'])
  })

  it('наблюдателю поле queue не отдаётся: прав на очередь у него нет', async () => {
    const list = (await api(app, await login(app, 'view@ops.test', 'view-password-123')).get('/events/deploys')).json.deploys
    expect(list.length).toBe(4)
    for (const d of list) expect(d).not.toHaveProperty('queue')
  })

  it('новый пункт виден со следующего запроса; сверх лимита — счётчик «ещё»', async () => {
    const owner = api(app, await login(app))
    expect(byRun((await owner.get('/events/deploys')).json.deploys, '3').queue).toBeNull()
    for (let i = 0; i < LINKS_PER_DEPLOY + 2; i++) await importDoc('items', `c-500-${i}`, { kind: 'check', title: `Проверка ${i} после #500` }, 'test')
    const q = byRun((await owner.get('/events/deploys')).json.deploys, '3').queue
    expect(q.links).toHaveLength(LINKS_PER_DEPLOY)
    expect(q.more).toBe(2)
  })
})
