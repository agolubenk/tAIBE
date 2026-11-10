/**
 * GET /api/oq/v1/prs — PR репозитория консоли за 7 дней для графика «Сколько PR ждали мёржа» на /queue (queue/prs.ts)
 * вместо снимка GitHub 15.10 в page.html. GitHub — подменённый транспорт: запросы GraphQL считаются и проверяются.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { setGithubTransportForTests, type GithubResponse } from '../server/queue/github'
import { resetPrsCacheForTests } from '../server/queue/prs'
import { getGithubSettings, writeSetting } from '../server/settings/store'
import { encryptSecret } from '../server/lib/crypto'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let agent: string
let taibe: string

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
type Node = { number: number; title: string; createdAt: string; mergedAt: string | null; state: string }
const node = (n: number, days: number, state: 'OPEN' | 'MERGED' | 'CLOSED'): Node => ({
  number: n, title: `PR ${n}`, createdAt: ago(days), mergedAt: state === 'MERGED' ? ago(days - 0.1) : null, state,
})

const calls: Array<{ path: string; body: { query: string; variables: Record<string, unknown> } }> = []
/** Страницы GraphQL по курсору: null — первая. */
function github(pages: Record<string, { nodes: Node[]; next: string | null }>) {
  return async (_m: string, path: string, _t: string, body?: unknown): Promise<GithubResponse> => {
    const b = body as { query: string; variables: Record<string, unknown> }
    calls.push({ path, body: b })
    const p = pages[String(b.variables.after ?? 'first')]!
    return { status: 200, text: JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: !!p.next, endCursor: p.next }, nodes: p.nodes } } } }) }
  }
}
const get = async (token: string, headers: Record<string, string> = {}) => {
  const res = await app.request('/api/oq/v1/prs', { headers: { Authorization: `Bearer ${token}`, ...headers } })
  return { status: res.status, etag: res.headers.get('ETag'), json: res.status === 200 ? ((await res.json()) as Record<string, any>) : null }
}
const put = (id: string, data: Record<string, unknown>) =>
  app.request(`/api/oq/v1/db/items/${id}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('test-agent', ['read', 'agent'])).token
  taibe = (await createToken('taibe-agent', ['read', 'agent'], { products: ['taibe'] })).token
  // Пункты мёржа: номер в поле pr и в команде — «из этой очереди»; PR другого репозитория с тем же номером — нет.
  expect((await put('m-501', { kind: 'merge', title: '#501', pr: 501 })).status).toBe(200)
  expect((await put('m-502', { kind: 'merge', title: '#502', cmd: 'gh pr merge 502 --merge' })).status).toBe(200)
  expect((await put('m-tb-503', { kind: 'merge', title: 'tAIBE #503', pr: 503, repo: 'agolubenk/tAIBE' })).status).toBe(200)
})

afterEach(() => {
  setGithubTransportForTests(null)
  resetPrsCacheForTests()
  calls.length = 0
})

describe('PR для графика очереди', () => {
  it('без токена мёржей — 200 с причиной, без запроса к GitHub', async () => {
    setGithubTransportForTests(github({ first: { nodes: [], next: null } }))
    const r = await get(agent)
    expect(r.status).toBe(200)
    expect(r.json!.prs).toEqual([])
    expect(r.json!.error).toMatch(/токена для мёржей/)
    expect(calls).toHaveLength(0)
  })

  describe('с токеном мёржей', () => {
    beforeAll(async () => {
      const gh = await getGithubSettings()
      await writeSetting('github', { ...gh, mergeTokenEnc: encryptSecret('github_pat_test_0000000000000000000000') })
    })

    it('окно 7 дней, закрытые без мёржа выброшены, старые — по порядку открытия; «из очереди» — по пунктам мёржа HR', async () => {
      setGithubTransportForTests(github({
        first: { nodes: [node(504, 0.5, 'OPEN'), node(503, 1, 'MERGED'), node(502, 2, 'MERGED'), node(501, 3, 'CLOSED')], next: 'c1' },
        c1: { nodes: [node(500, 6, 'MERGED'), node(499, 8, 'MERGED')], next: 'c2' },
        c2: { nodes: [node(498, 9, 'MERGED')], next: null },
      }))
      const r = await get(agent)
      expect(r.status).toBe(200)
      expect(r.json!.repo).toBe('agolubenk/HR_Helper-v2')
      expect(r.json!.days).toBe(7)
      expect(r.json!.prs.map((p: { n: number }) => p.n)).toEqual([500, 502, 503, 504])
      expect(r.json!.prs.map((p: { ours: boolean }) => p.ours)).toEqual([false, true, false, false])
      expect(r.json!.prs[3].merged).toBeNull()
      // Вторая страница ушла за окно — третьей не было; переменные owner и name — из настроек консоли.
      expect(calls.map((c) => c.body.variables.after)).toEqual([null, 'c1'])
      expect(calls[0]!.path).toBe('/graphql')
      expect(calls[0]!.body.variables).toMatchObject({ owner: 'agolubenk', name: 'HR_Helper-v2' })
    })

    it('ответ кэшируется: повтор не ходит в GitHub, If-None-Match — 304', async () => {
      setGithubTransportForTests(github({ first: { nodes: [node(504, 0.5, 'MERGED')], next: null } }))
      const a = await get(agent)
      expect(a.etag).toMatch(/^W\/"prs-/)
      const b = await get(agent, { 'If-None-Match': a.etag! })
      expect(b.status).toBe(304)
      expect((await get(agent)).json!.prs).toHaveLength(1)
      expect(calls).toHaveLength(1)
    })

    it('ошибка GitHub — причиной в ответе, не 500', async () => {
      setGithubTransportForTests(async () => ({ status: 200, text: JSON.stringify({ errors: [{ message: 'Resource not accessible' }] }) }))
      const r = await get(agent)
      expect(r.status).toBe(200)
      expect(r.json!.error).toMatch(/Resource not accessible/)
    })
  })

  it('токен без HR — 404: репозиторий консоли — HR, чужому продукту PR HR не показываются', async () => {
    setGithubTransportForTests(github({ first: { nodes: [node(504, 0.5, 'MERGED')], next: null } }))
    expect((await get(taibe)).status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
