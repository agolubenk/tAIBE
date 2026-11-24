/**
 * Полный список /changes по страницам (OPS-22, server/queue/changes-pages.ts): склеенные страницы равны прежнему
 * полному ответу (порядок, равные updated_at, потолок коллекции по числу и объёму), запись между страницами
 * догоняет дельта от курсора, плохой токен — 400, токен другого запуска или новее журнала — 410, видимость продуктов,
 * план запроса без SCAN. Прежний ответ без paged не меняется.
 */
import type { Client, InValue } from '@libsql/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { keysAfter, setPageLimitsForTests } from '../server/queue/changes-pages'
import { cursorOf, eventCursor } from '../server/queue/changes'
import { listDocs, setListLimitsForTests } from '../server/queue/list'
import { getDb, type OpsDb } from '../server/db/client'
import { oqDocs } from '../server/db/schema'
import type { Collection } from '../server/queue/store'

type App = Awaited<ReturnType<typeof freshApp>>
type Doc = { id: string; version: number; product: string; data: Record<string, unknown> }
type ListBody = { docs: Doc[]; truncated?: true; total?: number; limit?: number }
type FullBody = { full: true; cursor: string; collections: Record<string, ListBody> }
type PageBody = FullBody & { next?: string }
type DeltaBody = { cursor: string; changes: Record<string, { docs: Doc[]; removed: string[] }> }

let app: App
let hr: string
let taibe: string
let owner: string

async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/api/oq/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
}

async function fullList(token: string, q: string): Promise<FullBody> {
  const res = await call(token, `/changes?${q}`)
  expect(res.status).toBe(200)
  return (await res.json()) as FullBody
}

async function page(token: string, q: string, next?: string): Promise<PageBody> {
  const res = await call(token, `/changes?${q}&${next === undefined ? 'paged=1' : `page=${encodeURIComponent(next)}`}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.json()) as PageBody
}

/** Документы коллекций по порядку страниц; поля потолка — со страницы, где коллекция кончилась. */
function join(pages: PageBody[]): Record<string, ListBody> {
  const out: Record<string, ListBody> = {}
  for (const p of pages) {
    for (const [col, l] of Object.entries(p.collections)) {
      const acc = out[col] ?? { docs: [] }
      acc.docs = [...acc.docs, ...l.docs]
      if (l.truncated) Object.assign(acc, { truncated: l.truncated, total: l.total, limit: l.limit })
      out[col] = acc
    }
  }
  return out
}

async function allPages(token: string, q: string, first: PageBody[] = []): Promise<PageBody[]> {
  const pages = [...first]
  let next = pages.length ? pages.at(-1)!.next : undefined
  if (pages.length && next === undefined) return pages
  for (let n = 0; n < 500; n++) {
    const p = await page(token, q, next)
    pages.push(p)
    if (p.next === undefined) return pages
    next = p.next
  }
  throw new Error('больше 500 страниц')
}

const BASE = Date.UTC(2026, 0, 1)
/** Документы прямо в базу: равные updated_at и объём задаются точно. Без событий журнала — для дельт пишет API. */
async function seed(col: Collection, prefix: string, n: number, opts: { at?: number; pad?: number; product?: string } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    collection: col,
    id: `${prefix}-${String(i).padStart(3, '0')}`,
    dataJson: JSON.stringify({ kind: 'decision', title: `${prefix} ${i}`, pad: 'x'.repeat(opts.pad ?? 10) }),
    updatedAt: new Date(opts.at ?? BASE + i * 1000),
    product: opts.product ?? 'hr-helper',
  }))
  await getDb().insert(oqDocs).values(rows)
}

const item = (id: string) => ({ data: { kind: 'decision', title: `Решение ${id}`, body: 'Текст', options: [{ id: 'yes', label: 'Да', hint: 'рекомендую' }], source: 'test' } })
const shape = (docs: Doc[]) => docs.map((d) => `${d.id}@${d.version}`).sort()
const tokenJson = (t: string) => JSON.parse(Buffer.from(t, 'base64url').toString('utf8')) as Record<string, unknown>
const tokenOf = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')

beforeAll(async () => {
  app = await freshApp()
  hr = (await createToken('hr-agent', ['read', 'agent'])).token
  taibe = (await createToken('taibe-agent', ['read', 'agent'], { products: ['taibe'] })).token
  owner = (await createToken('bot', ['owner', 'read', 'agent'])).token
  await seed('items', 'it', 20, { pad: 300 })
  // Шесть документов с одним updated_at посреди коллекции: порядок между ними — по id.
  await seed('items', 'tie', 6, { at: BASE + 9500 })
  await seed('checks', 'ck', 5)
  await seed('items', 'tb', 3, { product: 'taibe' })
})

afterEach(() => {
  setPageLimitsForTests(null)
  setListLimitsForTests(null)
})

describe('склеенные страницы = прежний полный список', () => {
  it('по 4 документа: те же коллекции, документы и порядок (равные updated_at — по id), тот же курсор', async () => {
    setPageLimitsForTests({ docs: 4 })
    const q = 'col=checks,items,work'
    const want = await fullList(hr, q)
    const pages = await allPages(hr, q)
    expect(pages.length).toBeGreaterThan(5)
    for (const p of pages) expect(p.collections.items?.docs.length ?? 0).toBeLessThanOrEqual(4)
    expect(join(pages)).toEqual(want.collections)
    expect(Object.keys(join(pages))).toEqual(['checks', 'items', 'work'])
    for (const p of pages) expect(p.cursor).toBe(want.cursor)
    // Коллекция без документов на странице — только там, где она кончилась (последнее её появление).
    pages.forEach((p, i) => {
      for (const [col, l] of Object.entries(p.collections)) {
        if (!l.docs.length) expect(pages.slice(i + 1).some((later) => col in later.collections)).toBe(false)
      }
    })
    const ids = want.collections.items!.docs.map((d) => d.id)
    expect(ids.filter((id) => id.startsWith('tie-'))).toEqual(['tie-005', 'tie-004', 'tie-003', 'tie-002', 'tie-001', 'tie-000'])
  })

  it('потолок страницы по объёму: страница не больше потолка, кроме страницы из одного документа', async () => {
    setPageLimitsForTests({ bytes: 1000 })
    const q = 'col=items'
    const want = await fullList(hr, q)
    const pages = await allPages(hr, q)
    for (const p of pages) {
      const docs = p.collections.items?.docs ?? []
      const bytes = docs.reduce((s, d) => s + Buffer.byteLength(JSON.stringify(d.data)), 0)
      expect(docs.length === 1 || bytes <= 1000).toBe(true)
    }
    expect(join(pages)).toEqual(want.collections)
  })

  it('без paged — прежнее тело байт в байт: full, cursor, collections, без next', async () => {
    const text = await (await call(owner, '/changes?col=items')).text()
    const docs = (await listDocs('items', '*')).docs
    expect(text).toBe(JSON.stringify({ full: true, cursor: cursorOf(await eventCursor()), collections: { items: { docs } } }))
  })

  it('пустая коллекция — одна страница с пустым списком', async () => {
    const p = await page(hr, 'col=work')
    expect(p).toEqual({ full: true, cursor: expect.stringMatching(/^[0-9a-z]+\.\d+$/), collections: { work: { docs: [] } } })
  })

  it('paged=1 и page вместе — берётся page', async () => {
    setPageLimitsForTests({ docs: 3 })
    const first = await page(hr, 'col=items')
    const second = await page(hr, 'col=items', first.next)
    const res = await call(hr, `/changes?col=items&paged=1&page=${encodeURIComponent(first.next!)}`)
    expect(await res.json()).toEqual(second)
  })
})

describe('потолок коллекции — как у прежнего полного списка', () => {
  it('по числу документов: тот же срез, truncated, total и limit', async () => {
    setListLimitsForTests({ max: 7 })
    setPageLimitsForTests({ docs: 3 })
    const want = await fullList(hr, 'col=items')
    expect(want.collections.items!.truncated).toBe(true)
    expect(join(await allPages(hr, 'col=items'))).toEqual(want.collections)
  })

  it('по объёму: тот же срез; самый свежий больше потолка — пусто и truncated', async () => {
    setPageLimitsForTests({ docs: 2 })
    for (const bytes of [2000, 50]) {
      setListLimitsForTests({ bytes })
      const want = await fullList(hr, 'col=checks,items')
      expect(want.collections.items!.truncated).toBe(true)
      expect(join(await allPages(hr, 'col=checks,items'))).toEqual(want.collections)
    }
    expect((await fullList(hr, 'col=items')).collections.items!.docs).toEqual([])
  })
})

describe('запись между страницами', () => {
  it('новый, изменённый и ушедший в другой продукт ещё не отданные, удалённый отданный — дельта от курсора страниц догоняет', async () => {
    setPageLimitsForTests({ docs: 3 })
    const q = 'col=items'
    const p1 = await page(hr, q)
    const sent = p1.collections.items!.docs[0]!.id
    const before = await fullList(hr, q)
    const notYet = before.collections.items!.docs.at(-1)!.id
    const moved = before.collections.items!.docs.at(-2)!.id
    expect((await call(hr, '/db/items/d-pg-new', { method: 'PUT', body: item('d-pg-new') })).status).toBe(200)
    expect((await call(hr, `/db/items/${notYet}`, { method: 'PUT', body: item(notYet) })).status).toBe(200)
    expect((await call(owner, `/items/${moved}/product`, { method: 'POST', body: { to: 'taibe' } })).status).toBe(200)
    expect((await call(owner, `/db/items/${sent}`, { method: 'DELETE' })).status).toBe(200)
    const pages = await allPages(hr, q, [p1])
    const docs = join(pages).items!.docs
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length)
    const delta = (await (await call(hr, `/changes?col=items&since=${encodeURIComponent(p1.cursor)}`)).json()) as DeltaBody
    const byId = new Map(docs.map((d) => [d.id, d]))
    for (const id of delta.changes.items!.removed) byId.delete(id)
    for (const d of delta.changes.items!.docs) byId.set(d.id, d)
    const after = (await fullList(hr, q)).collections.items!.docs
    expect(shape([...byId.values()])).toEqual(shape(after))
    expect(after.map((d) => d.id)).not.toContain(moved)
    expect(delta.changes.items!.removed).toEqual(expect.arrayContaining([sent, moved]))
  })
})

describe('видимость продуктов', () => {
  it('токен продукта видит только свои документы; склейка = его полный список', async () => {
    setPageLimitsForTests({ docs: 2 })
    const tb = join(await allPages(taibe, 'col=items'))
    expect(tb).toEqual((await fullList(taibe, 'col=items')).collections)
    expect(tb.items!.docs.map((d) => d.id)).toEqual(expect.arrayContaining(['tb-002', 'tb-001', 'tb-000']))
    expect(tb.items!.docs.every((d) => d.product === 'taibe')).toBe(true)
    const own = join(await allPages(hr, 'col=items'))
    expect(own).toEqual((await fullList(hr, 'col=items')).collections)
    expect(own.items!.docs.some((d) => d.product === 'taibe')).toBe(false)
  })
})

describe('плохой токен — 400, устаревший — 410', () => {
  async function next(): Promise<string> {
    setPageLimitsForTests({ docs: 2 })
    const p = await page(hr, 'col=items')
    expect(p.next).toBeTruthy()
    return p.next!
  }
  const status = async (token: string, q: string) => (await call(token, `/changes?${q}`)).status

  it('мусор, пустой, длинный, чужая схема — 400', async () => {
    const t = tokenJson(await next())
    for (const bad of ['!!!', '', 'a'.repeat(600), tokenOf({ v: 2 }), tokenOf({ ...t, extra: 1 }), tokenOf({ ...t, id: null }), tokenOf({ ...t, col: 'work' }), tokenOf({ ...t, id: 'bad id' })]) {
      expect(await status(hr, `col=items&page=${encodeURIComponent(bad)}`)).toBe(400)
    }
  })

  it('другой набор коллекций или другая видимость — 400', async () => {
    const t = await next()
    expect(await status(hr, `col=checks,items&page=${encodeURIComponent(t)}`)).toBe(400)
    expect(await status(hr, `col=items&product=taibe&page=${encodeURIComponent(t)}`)).toBe(400)
    expect(await status(taibe, `col=items&page=${encodeURIComponent(t)}`)).toBe(400)
  })

  it('since вместе с paged или page, paged не 1 — 400', async () => {
    const { cursor } = await fullList(hr, 'col=items')
    expect(await status(hr, `col=items&paged=1&since=${encodeURIComponent(cursor)}`)).toBe(400)
    expect(await status(hr, `col=items&page=${encodeURIComponent(await next())}&since=${encodeURIComponent(cursor)}`)).toBe(400)
    expect(await status(hr, 'col=items&paged=2')).toBe(400)
  })

  it('токен другого запуска консоли или новее журнала — 410 с resync', async () => {
    const t = tokenJson(await next())
    for (const stale of [tokenOf({ ...t, boot: 'zzzzzz' }), tokenOf({ ...t, cur: Number(t.cur) + 1_000_000 })]) {
      const res = await call(hr, `/changes?col=items&page=${encodeURIComponent(stale)}`)
      expect(res.status).toBe(410)
      expect(((await res.json()) as { resync: boolean }).resync).toBe(true)
    }
  })
})

describe('план запроса ключей', () => {
  it.each([['все продукты', '*' as const], ['продукты токена', ['hr-helper', 'taibe']]])('%s — поиск по индексу, без SCAN таблицы', async (_name, products) => {
    for (const [u, id] of [[null, null], [BASE + 5000, 'it-005']] as const) {
      const q = keysAfter('items', products, u, id, 5).toSQL()
      // drizzle держит клиент libSQL в $client, тип OpsDb его не объявляет.
      const plan = await (getDb() as OpsDb & { $client: Client }).$client.execute({ sql: `EXPLAIN QUERY PLAN ${q.sql}`, args: q.params as InValue[] })
      const detail = plan.rows.map((r) => String(r.detail)).join('\n')
      expect(detail).toMatch(/SEARCH oq_docs USING (COVERING )?INDEX/)
      expect(detail).not.toMatch(/\bSCAN oq_docs\b/)
    }
  })
})
