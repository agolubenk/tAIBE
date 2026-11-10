/**
 * PR репозитория консоли за 7 дней — для графика «Сколько PR ждали мёржа» на /queue вместо снимка GitHub 15.10,
 * вшитого в page.html. Источник — GitHub GraphQL токеном мёржей (queue/github.ts); «из этой очереди» — PR, у которого
 * есть пункт мёржа HR в очереди (номер — тем же правилом mergePlan, что у кнопки «Влить»).
 * Репозиторий в настройках консоли один — HR: токен без HR получает null (маршрут — 404). Ответ кэшируется на 5 минут
 * (ошибка — на минуту): страницы и бот не тратят лимит GitHub на каждое открытие.
 */
import { z } from 'zod'
import { githubGraphql, mergePlan } from './github'
import { listDocs } from './list'
import { canSee, DEFAULT_PRODUCT, type Visibility } from './products'

export const PR_WINDOW_DAYS = 7
const DAY_MS = 86_400_000
const PAGES = 3
const TTL_MS = 5 * 60_000
const ERROR_TTL_MS = 60_000

const QUERY = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor}nodes{number title createdAt mergedAt state}}}}`

const pageSchema = z.object({
  repository: z.object({
    pullRequests: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.object({ number: z.number(), title: z.string(), createdAt: z.string(), mergedAt: z.string().nullable(), state: z.string() })),
    }),
  }),
})

export interface PrPoint {
  n: number
  title: string
  opened: string
  /** null — PR ещё открыт. */
  merged: string | null
  ours: boolean
}
export interface PrList {
  repo: string | null
  at: string
  days: number
  prs: PrPoint[]
  error?: string
}

let cache: { at: number; ttl: number; body: Promise<PrList> } | null = null

/** Сброс кэша в тестах. */
export function resetPrsCacheForTests(): void {
  cache = null
}

/** Номера PR из пунктов мёржа HR; пункт другого репозитория (поле repo или -R команды) — не этот PR. */
async function queuePrNumbers(repo: string): Promise<Set<number>> {
  const out = new Set<number>()
  for (const d of (await listDocs('items', [DEFAULT_PRODUCT])).docs) {
    if (d.data.kind !== 'merge') continue
    const plan = mergePlan(d.data)
    if (plan.pr && (!plan.repo || plan.repo.toLowerCase() === repo.toLowerCase())) out.add(plan.pr)
  }
  return out
}

async function load(now: number): Promise<PrList> {
  const since = now - PR_WINDOW_DAYS * DAY_MS
  const nodes: z.infer<typeof pageSchema>['repository']['pullRequests']['nodes'] = []
  let repo = ''
  let after: string | null = null
  // Страницы — от новых к старым, пока не вышли за окно: ~15 PR в день — одна-две страницы.
  for (let i = 0; i < PAGES; i++) {
    const r = await githubGraphql(QUERY, { after })
    repo = r.repo
    const page = pageSchema.parse(r.data).repository.pullRequests
    nodes.push(...page.nodes)
    const last = page.nodes[page.nodes.length - 1]
    if (!page.pageInfo.hasNextPage || !last || Date.parse(last.createdAt) < since) break
    after = page.pageInfo.endCursor
  }
  const ours = await queuePrNumbers(repo)
  const prs = nodes
    // Закрытый без мёржа — не ждал мёржа: на графике его нет.
    .filter((p) => Date.parse(p.createdAt) >= since && (p.state === 'OPEN' || p.mergedAt))
    .map((p) => ({ n: p.number, title: p.title.slice(0, 160), opened: p.createdAt, merged: p.mergedAt, ours: ours.has(p.number) }))
    .reverse()
  return { repo, at: new Date(now).toISOString(), days: PR_WINDOW_DAYS, prs }
}

/** PR за окно для графика; null — актору не виден HR (репозиторий консоли — HR). */
export function recentPrs(products: Visibility, now = Date.now()): Promise<PrList> | null {
  if (!canSee(products, DEFAULT_PRODUCT)) return null
  if (cache && now - cache.at < cache.ttl) return cache.body
  // Ошибка (нет токена, GitHub недоступен) — ответом с полем error: страница пишет причину вместо графика.
  const body: Promise<PrList> = load(now).catch((e: unknown) => {
    if (cache?.body === body) cache.ttl = ERROR_TTL_MS
    return { repo: null, at: new Date(now).toISOString(), days: PR_WINDOW_DAYS, prs: [], error: e instanceof Error ? e.message : String(e) }
  })
  cache = { at: now, ttl: TTL_MS, body }
  return body
}
