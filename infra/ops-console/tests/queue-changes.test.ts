/**
 * Дельта коллекции /api/oq/v1/changes/:col (OPS-50, server/queue/changes.ts): полный список с курсором, изменённые и
 * удалённые документы после курсора, видимость продуктов, 410 при негодном курсоре. Применение дельт к полному списку
 * даёт тот же список, что новый полный запрос. Прежний GET /db/:col не меняется.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { setChangesLimitsForTests } from '../server/queue/changes'

type App = Awaited<ReturnType<typeof freshApp>>
type Doc = { id: string; version: number; product: string; data: Record<string, unknown> }
type FullBody = { full: true; cursor: string; collections: Record<string, { docs: Doc[] }> }
type DeltaBody = { cursor: string; changes: Record<string, { docs: Doc[]; removed: string[] }> }
/** Одна коллекция items — для краткости проверок. */
type Full = { cursor: string; docs: Doc[] }
type Delta = { cursor: string; docs: Doc[]; removed: string[] }

let app: App
let hr: string
let taibe: string
let owner: string

async function call(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api/oq/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res
}

const item = (id: string, title = `Решение ${id}`) => ({
  data: { kind: 'decision', title, body: 'Текст', options: [{ id: 'yes', label: 'Да', hint: 'рекомендую' }], source: 'test' },
})

async function put(token: string, id: string, title?: string) {
  expect((await call(token, 'PUT', `/db/items/${id}`, item(id, title))).status).toBe(200)
}

async function full(token: string): Promise<Full> {
  const body = (await (await call(token, 'GET', '/changes?col=items')).json()) as FullBody
  return { cursor: body.cursor, docs: body.collections.items!.docs }
}
async function delta(token: string, cursor: string, extra = ''): Promise<Delta> {
  const body = (await (await call(token, 'GET', `/changes?col=items&since=${encodeURIComponent(cursor)}${extra}`)).json()) as DeltaBody
  return { cursor: body.cursor, ...body.changes.items! }
}

/** Список после применения дельты: документы заменяются целиком, removed удаляются. */
function apply(docs: Doc[], d: Delta): Doc[] {
  const byId = new Map(docs.map((x) => [x.id, x]))
  for (const id of d.removed) byId.delete(id)
  for (const x of d.docs) byId.set(x.id, x)
  return [...byId.values()]
}
const shape = (docs: Doc[]) => docs.map((d) => `${d.id}@${d.version}`).sort()

beforeAll(async () => {
  app = await freshApp()
  hr = (await createToken('hr-agent', ['read', 'agent'])).token
  taibe = (await createToken('taibe-agent', ['read', 'agent'], { products: ['taibe'] })).token
  owner = (await createToken('bot', ['owner', 'read', 'agent'])).token
  await put(hr, 'd-ch-1')
  await put(hr, 'd-ch-2')
})

afterEach(() => setChangesLimitsForTests(null))

describe('полный список с курсором', () => {
  it('без since и col — все три коллекции, курсор и full: true; без ETag (304 не вернул бы курсор)', async () => {
    const res = await call(hr, 'GET', '/changes')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as FullBody
    expect(body.full).toBe(true)
    expect(body.cursor).toMatch(/^[0-9a-z]+\.\d+$/)
    expect(Object.keys(body.collections)).toEqual(['checks', 'items', 'work'])
    expect(body.collections.items!.docs.map((d) => d.id)).toEqual(expect.arrayContaining(['d-ch-1', 'd-ch-2']))
  })

  it('gzip — сжатое тело с тем же содержимым, без ETag', async () => {
    const res = await call(hr, 'GET', '/changes?col=checks,items', undefined, { 'Accept-Encoding': 'gzip' })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('etag')).toBeNull()
    const text = await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()
    const body = JSON.parse(text) as FullBody
    expect(Object.keys(body.collections)).toEqual(['checks', 'items'])
    expect(body.collections.items!.docs.map((d) => d.id)).toEqual(expect.arrayContaining(['d-ch-1']))
  })

  it('нет такой коллекции — 404', async () => {
    expect((await call(hr, 'GET', '/changes?col=items,nope')).status).toBe(404)
  })

  it('прежний GET /db/items не меняется: только docs, ETag и 304', async () => {
    const res = await call(hr, 'GET', '/db/items')
    expect(Object.keys((await res.json()) as object)).toEqual(['docs'])
    expect((await call(hr, 'GET', '/db/items', undefined, { 'If-None-Match': res.headers.get('etag')! })).status).toBe(304)
  })
})

describe('дельта после курсора', () => {
  it('без изменений — пусто, курсор тот же', async () => {
    const { cursor } = await full(hr)
    expect(await delta(hr, cursor)).toEqual({ cursor, docs: [], removed: [] })
  })

  it('правка одного документа — только он, новый курсор', async () => {
    const start = await full(hr)
    await put(hr, 'd-ch-1', 'Новый заголовок')
    const d = await delta(hr, start.cursor)
    expect(d.docs.map((x) => x.id)).toEqual(['d-ch-1'])
    expect(d.docs[0]!.data.title).toBe('Новый заголовок')
    expect(d.removed).toEqual([])
    expect(d.cursor).not.toBe(start.cursor)
    expect(await delta(hr, d.cursor)).toEqual({ cursor: d.cursor, docs: [], removed: [] })
  })

  it('архив — документ в docs с archived: true; удаление владельцем — id в removed', async () => {
    await put(hr, 'd-ch-arch')
    await put(hr, 'd-ch-del')
    const start = await full(hr)
    expect((await call(hr, 'PATCH', '/db/items/d-ch-arch', { data: { archived: true } })).status).toBe(200)
    expect((await call(owner, 'DELETE', '/db/items/d-ch-del')).status).toBe(200)
    const d = await delta(hr, start.cursor)
    expect(d.docs.map((x) => [x.id, x.data.archived])).toEqual([['d-ch-arch', true]])
    expect(d.removed).toEqual(['d-ch-del'])
  })

  it('дельты, применённые к полному списку, дают новый полный список', async () => {
    let list = await full(hr)
    let docs = list.docs
    await put(hr, 'd-ch-a')
    await put(hr, 'd-ch-b')
    let d = await delta(hr, list.cursor)
    docs = apply(docs, d)
    await put(hr, 'd-ch-a', 'правка')
    expect((await call(owner, 'DELETE', '/db/items/d-ch-b')).status).toBe(200)
    await put(hr, 'd-ch-c')
    d = await delta(hr, d.cursor)
    docs = apply(docs, d)
    list = await full(hr)
    expect(shape(docs)).toEqual(shape(list.docs))
  })

  it('чужая коллекция в дельту items не попадает; дельта нескольких коллекций — по группам', async () => {
    const { cursor } = await full(hr)
    expect((await call(hr, 'PUT', '/db/work/w-ch-1', { data: { kind: 'track', title: 'строка' } })).status).toBe(200)
    expect(await delta(hr, cursor)).toEqual({ cursor: expect.any(String), docs: [], removed: [] })
    await put(hr, 'd-ch-pair')
    expect((await call(hr, 'PATCH', '/db/checks/d-ch-pair', { data: { agentStatus: 'doing', agentNote: 'беру' } })).status).toBe(200)
    const body = (await (await call(hr, 'GET', `/changes?col=checks,items,work&since=${cursor}`)).json()) as DeltaBody
    expect(Object.fromEntries(Object.entries(body.changes).map(([k, v]) => [k, [v.docs.map((d) => d.id), v.removed]]))).toEqual({
      checks: [['d-ch-pair'], []],
      items: [['d-ch-pair'], []],
      work: [['w-ch-1'], []],
    })
  })

  it('потолок считает только запрошенные коллекции', async () => {
    const { cursor } = await full(hr)
    setChangesLimitsForTests({ docs: 2 })
    for (const id of ['w-ch-c1', 'w-ch-c2', 'w-ch-c3']) {
      expect((await call(hr, 'PUT', `/db/work/${id}`, { data: { kind: 'track', title: id } })).status).toBe(200)
    }
    expect(await delta(hr, cursor)).toEqual({ cursor: expect.any(String), docs: [], removed: [] })
  })
})

describe('видимость продуктов', () => {
  it('запись в чужом продукте — пустая дельта, id чужого документа не виден', async () => {
    const { cursor } = await full(hr)
    await put(taibe, 'taibe-d-ch-1')
    const d = await delta(hr, cursor)
    expect(d.docs).toEqual([])
    expect(d.removed).toEqual([])
    expect((await delta(taibe, cursor)).docs.map((x) => x.id)).toEqual(['taibe-d-ch-1'])
  })

  it('смена продукта — прежний продукт видит removed, новый — документ', async () => {
    await put(hr, 'd-ch-move')
    const hrStart = await full(hr)
    const taibeStart = await full(taibe)
    expect((await call(owner, 'POST', '/items/d-ch-move/product', { to: 'taibe' })).status).toBe(200)
    expect(await delta(hr, hrStart.cursor)).toMatchObject({ docs: [], removed: ['d-ch-move'] })
    const t = await delta(taibe, taibeStart.cursor)
    expect(t.docs.map((x) => [x.id, x.product])).toEqual([['d-ch-move', 'taibe']])
  })

  it('?product= — как у списка: невидимый продукт — пустая дельта', async () => {
    const { cursor } = await full(taibe)
    await put(taibe, 'taibe-d-ch-2')
    expect((await delta(taibe, cursor, '&product=hr-helper')).docs).toEqual([])
    expect((await delta(owner, cursor, '&product=taibe')).docs.map((x) => x.id)).toEqual(['taibe-d-ch-2'])
  })
})

describe('негодный курсор', () => {
  it('не курсор — 400', async () => {
    expect((await call(hr, 'GET', '/changes?since=abc')).status).toBe(400)
    expect((await call(hr, 'GET', '/changes?since=12')).status).toBe(400)
  })

  it('другой запуск консоли — 410 resync', async () => {
    const res = await call(hr, 'GET', '/changes?since=zz.1')
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ resync: true })
  })

  it('курсор новее журнала (база сменилась) — 410', async () => {
    const boot = (await full(hr)).cursor.split('.')[0]
    expect((await call(hr, 'GET', `/changes?since=${boot}.999999999`)).status).toBe(410)
  })

  it('изменённых документов больше потолка — 410, клиент берёт полный список', async () => {
    const { cursor } = await full(hr)
    setChangesLimitsForTests({ docs: 2 })
    for (const id of ['d-ch-x1', 'd-ch-x2', 'd-ch-x3']) await put(hr, id)
    const res = await call(hr, 'GET', `/changes?col=items&since=${cursor}`)
    expect(res.status).toBe(410)
    expect(((await res.json()) as { reason: string }).reason).toMatch(/больше 2 документов/)
  })

  it('после 410 сжатый полный список из кэша несёт свежий курсор — 410 по кругу нет (линза Контроля #623)', async () => {
    const gzFull = async () => {
      const res = await call(hr, 'GET', '/changes?col=items', undefined, { 'Accept-Encoding': 'gzip' })
      return JSON.parse(await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()) as FullBody
    }
    const first = await gzFull()
    setChangesLimitsForTests({ events: 2 })
    // Только события чужого продукта: теги видимых коллекций HR не меняются, курсор — меняется.
    for (const id of ['taibe-d-ch-z1', 'taibe-d-ch-z2', 'taibe-d-ch-z3']) await put(taibe, id)
    expect((await call(hr, 'GET', `/changes?col=items&since=${first.cursor}`)).status).toBe(410)
    const again = await gzFull()
    expect(again.cursor).not.toBe(first.cursor)
    expect((await call(hr, 'GET', `/changes?col=items&since=${again.cursor}`)).status).toBe(200)
  })

  it('событий журнала больше потолка — 410 без чтения журнала', async () => {
    const { cursor } = await full(hr)
    setChangesLimitsForTests({ events: 1 })
    await put(hr, 'd-ch-y1')
    await put(hr, 'd-ch-y2')
    expect((await call(hr, 'GET', `/changes?col=items&since=${cursor}`)).status).toBe(410)
  })
})
