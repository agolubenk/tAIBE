/**
 * Продукты очереди (v2-lite, план мультипродуктовой очереди, фаза 3): матрица «токен продукта A × документ B» по всем
 * эндпоинтам, продукт нового документа, правило id, старый клиент HR без изменений, мёрж только для HR.
 */
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { oqDocs, oqTokens } from '../server/db/schema'
import { createToken } from '../server/queue/auth'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let hr: string
let taibe: string
let both: string
let owner: string

const call = async (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(`/api/oq/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, etag: res.headers.get('etag'), json: text ? (JSON.parse(text) as Record<string, unknown>) : null }
}

const decision = (title: string) => ({ kind: 'decision', title, options: [{ id: 'yes', label: 'Да' }], source: 'test' })
const ids = (r: { json: Record<string, unknown> | null }) => ((r.json?.docs ?? []) as { id: string }[]).map((d) => d.id).sort()

beforeAll(async () => {
  app = await freshApp()
  hr = (await createToken('hr-agent', ['read', 'agent'])).token
  taibe = (await createToken('taibe-agent', ['read', 'agent'], { products: ['taibe'] })).token
  both = (await createToken('two-products', ['read', 'agent'], { products: ['hr-helper', 'taibe'] })).token
  owner = (await createToken('bot', ['owner'])).token
  expect((await call(hr, 'PUT', '/db/items/d-hr-1', { data: decision('HR') })).status).toBe(200)
  expect((await call(taibe, 'PUT', '/db/items/taibe-d-1', { data: decision('tAIBE') })).status).toBe(200)
})

describe('продукты — схема и справочник', () => {
  it('три продукта из миграции, HR — по умолчанию; токен видит только свои', async () => {
    const all = await call(owner, 'GET', '/products')
    expect(all.json?.products).toEqual([
      { slug: 'hr-helper', name: 'HR Helper', isDefault: true },
      { slug: 'lavaeon', name: 'Lavaeon', isDefault: false },
      { slug: 'taibe', name: 'aiBoards&eval', isDefault: false },
    ])
    expect(((await call(taibe, 'GET', '/products')).json?.products as { slug: string }[]).map((p) => p.slug)).toEqual(['taibe'])
  })

  it('продукт нового документа — продукт токена; у документа он рядом с data', async () => {
    const doc = await call(hr, 'GET', '/db/items/d-hr-1')
    expect(doc.json).toMatchObject({ id: 'd-hr-1', product: 'hr-helper' })
    expect((doc.json?.data as Record<string, unknown>).product).toBeUndefined()
    expect((await call(owner, 'GET', '/db/items/taibe-d-1')).json).toMatchObject({ product: 'taibe' })
  })
})

describe('изоляция: токен продукта A × документ B', () => {
  it('список, ?open=1, документ, история — чужого не видно; чужой id — 404, как несуществующий', async () => {
    expect(ids(await call(hr, 'GET', '/db/items'))).toEqual(['d-hr-1'])
    expect(ids(await call(taibe, 'GET', '/db/items'))).toEqual(['taibe-d-1'])
    expect(ids(await call(hr, 'GET', '/db/items?open=1'))).toEqual(['d-hr-1'])
    expect(ids(await call(owner, 'GET', '/db/items'))).toEqual(['d-hr-1', 'taibe-d-1'])
    expect(ids(await call(both, 'GET', '/db/items'))).toEqual(['d-hr-1', 'taibe-d-1'])
    expect((await call(hr, 'GET', '/db/items/taibe-d-1')).status).toBe(404)
    expect((await call(hr, 'GET', '/db/items/no-such')).status).toBe(404)
    expect((await call(hr, 'GET', '/history/items/taibe-d-1')).json?.events).toEqual([])
    expect(((await call(taibe, 'GET', '/history/items/taibe-d-1')).json?.events as unknown[]).length).toBe(1)
  })

  it('запись в чужой документ — 404 до проверок версии и прав; ответ на чужой пункт — 404', async () => {
    expect((await call(hr, 'PATCH', '/db/items/taibe-d-1', { data: { title: 'чужое' }, ifVersion: 99 })).status).toBe(404)
    expect((await call(taibe, 'PATCH', '/db/checks/d-hr-1', { data: { agentStatus: 'doing' } })).status).toBe(404)
  })

  it('тег списка не меняется от записи в чужом продукте: 304 у HR, 200 у владельца', async () => {
    const hrTag = (await call(hr, 'GET', '/db/items')).etag!
    const ownerTag = (await call(owner, 'GET', '/db/items')).etag!
    expect(hrTag).not.toBe(ownerTag)
    expect((await call(taibe, 'PUT', '/db/items/taibe-d-2', { data: decision('ещё tAIBE') })).status).toBe(200)
    expect((await call(hr, 'GET', '/db/items', undefined, { 'If-None-Match': hrTag })).status).toBe(304)
    expect((await call(owner, 'GET', '/db/items', undefined, { 'If-None-Match': ownerTag })).status).toBe(200)
  })

  it('сжатый список — свой у каждой видимости: кэш тела не отдаёт HR документы tAIBE', async () => {
    const gz = { 'Accept-Encoding': 'gzip' }
    const full = await app.request('/api/oq/v1/db/items', { headers: { Authorization: `Bearer ${owner}`, ...gz } })
    expect(full.headers.get('content-encoding')).toBe('gzip')
    const res = await app.request('/api/oq/v1/db/items', { headers: { Authorization: `Bearer ${hr}`, ...gz } })
    const text = await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()
    expect((JSON.parse(text) as { docs: { id: string }[] }).docs.map((d) => d.id)).toEqual(['d-hr-1'])
  })
})

describe('продукт нового документа и id', () => {
  it('ответ наследует продукт пункта; product в data — 422; другой продукт у существующего — 409', async () => {
    expect((await call(taibe, 'PATCH', '/db/checks/taibe-d-1', { data: { agentStatus: 'doing' } })).status).toBe(200)
    expect((await call(owner, 'GET', '/db/checks/taibe-d-1')).json).toMatchObject({ product: 'taibe' })
    expect((await call(hr, 'PUT', '/db/items/d-hr-2', { data: { ...decision('x'), product: 'taibe' } })).status).toBe(422)
    expect((await call(both, 'PATCH', '/db/items/d-hr-1', { data: { title: 'HR' }, product: 'taibe' })).status).toBe(409)
  })

  it('id продукта не по умолчанию — с его префиксом; чужой префикс — 409', async () => {
    expect((await call(taibe, 'PUT', '/db/items/d-no-prefix', { data: decision('x') })).status).toBe(422)
    expect((await call(hr, 'PUT', '/db/items/taibe-d-9', { data: decision('x') })).status).toBe(409)
  })

  it('владелец и токен с несколькими продуктами — product запроса или продукт по умолчанию; невидимый — 422', async () => {
    expect((await call(owner, 'PUT', '/db/items/taibe-d-3', { data: decision('от владельца'), product: 'taibe' })).json).toMatchObject({ product: 'taibe' })
    expect((await call(owner, 'PUT', '/db/items/d-owner-1', { data: decision('по умолчанию') })).json).toMatchObject({ product: 'hr-helper' })
    expect((await call(both, 'PUT', '/db/items/d-both-1', { data: decision('по умолчанию') })).json).toMatchObject({ product: 'hr-helper' })
    expect((await call(taibe, 'PUT', '/db/items/lavaeon-d-1', { data: decision('x'), product: 'lavaeon' })).status).toBe(422)
    expect((await call(owner, 'PUT', '/db/items/nope-d-1', { data: decision('x'), product: 'nope' })).status).toBe(422)
  })
})

describe('токены', () => {
  it('«*» — только у owner; неизвестный продукт не выпускается', async () => {
    await expect(createToken('x', ['agent'], { products: ['*'] })).rejects.toThrow(/owner/)
    await expect(createToken('x', ['agent'], { products: ['nope'] })).rejects.toThrow(/nope/)
    expect((await createToken('all', ['owner'], { products: ['*'] })).token).toMatch(/^oq_/)
  })

  it('истёкший токен — 401', async () => {
    const t = await createToken('short', ['read'], { expiresDays: 1 })
    expect((await call(t.token, 'GET', '/db/items')).status).toBe(200)
    await getDb().update(oqTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oqTokens.id, t.id))
    expect((await call(t.token, 'GET', '/db/items')).status).toBe(401)
  })

  it('старый токен (строка до v2-lite) — продукт HR по DEFAULT столбца', async () => {
    const t = await createToken('legacy', ['read'])
    const [row] = await getDb().select({ products: oqTokens.products }).from(oqTokens).where(eq(oqTokens.id, t.id))
    expect(row?.products).toBe('["hr-helper"]')
    expect(ids(await call(t.token, 'GET', '/db/items'))).not.toContain('taibe-d-1')
  })
})

describe('мёрж из очереди — пока только HR', () => {
  it('пункт мёржа другого продукта — 409 до обращения к GitHub', async () => {
    expect((await call(owner, 'PUT', '/db/items/taibe-m-1', { data: { kind: 'merge', title: 'Влить', pr: 1 }, product: 'taibe' })).status).toBe(200)
    const res = await call(owner, 'GET', '/merge/taibe-m-1')
    expect(res.status).toBe(409)
    expect(String(res.json?.error ?? res.json?.message ?? JSON.stringify(res.json))).toMatch(/taibe/)
  })

  it('строки старого образа без продукта — продукт HR (DEFAULT миграции)', async () => {
    await getDb().insert(oqDocs).values({ collection: 'items', id: 'd-old-image', dataJson: JSON.stringify(decision('старый образ')) })
    expect((await call(hr, 'GET', '/db/items/d-old-image')).json).toMatchObject({ product: 'hr-helper' })
  })
})
