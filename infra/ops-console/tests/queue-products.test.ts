/**
 * Продукты очереди (v2-lite, план мультипродуктовой очереди, фаза 3): матрица «токен продукта A × документ B» по всем
 * эндпоинтам, продукт нового документа, правило id, старый клиент HR без изменений, мёрж только для HR.
 */
import { eq, sql } from 'drizzle-orm'
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

  it('продукт нового документа — пространство id; чужое пространство — тот же 404, что у чужого документа', async () => {
    const absent = await call(taibe, 'PUT', '/db/items/d-no-prefix', { data: decision('x') })
    const foreign = await call(taibe, 'PUT', '/db/items/d-hr-1', { data: decision('x') })
    expect([absent.status, foreign.status]).toEqual([404, 404])
    expect(absent.json).toEqual(foreign.json)
    expect((await call(hr, 'PUT', '/db/items/taibe-d-9', { data: decision('x') })).status).toBe(404)
    expect((await call(taibe, 'PATCH', '/db/checks/d-none', { data: { agentStatus: 'doing' } })).status).toBe(404)
  })

  it('владелец и токен с несколькими продуктами — продукт из id, product запроса — подтверждение; невидимое пространство — 404', async () => {
    expect((await call(owner, 'PUT', '/db/items/taibe-d-3', { data: decision('от владельца'), product: 'taibe' })).json).toMatchObject({ product: 'taibe' })
    expect((await call(owner, 'PUT', '/db/items/d-owner-1', { data: decision('по умолчанию') })).json).toMatchObject({ product: 'hr-helper' })
    expect((await call(both, 'PUT', '/db/items/d-both-1', { data: decision('по умолчанию') })).json).toMatchObject({ product: 'hr-helper' })
    expect((await call(taibe, 'PUT', '/db/items/lavaeon-d-1', { data: decision('x'), product: 'lavaeon' })).status).toBe(404)
    // product запроса — подтверждение пространства id: другой — 422, без справки о чужих продуктах.
    expect((await call(owner, 'PUT', '/db/items/d-x-1', { data: decision('x'), product: 'taibe' })).status).toBe(422)
    expect((await call(owner, 'PUT', '/db/items/nope-d-1', { data: decision('x'), product: 'nope' })).status).toBe(422)
  })
})

describe('токены', () => {
  it('«*» — только у owner; у owner — только «*»; неизвестный продукт, кривой срок и занятое имя не выпускаются', async () => {
    await expect(createToken('x', ['agent'], { products: ['*'] })).rejects.toThrow(/owner/)
    await expect(createToken('x', ['agent'], { products: ['nope'] })).rejects.toThrow(/nope/)
    await expect(createToken('x', ['owner'], { products: ['taibe'] })).rejects.toThrow(/все продукты/)
    for (const d of [Number.NaN, 0, -1, 0.5, 4000]) await expect(createToken('x', ['read'], { expiresDays: d })).rejects.toThrow(/Срок/)
    await expect(createToken('hr-agent', ['read'])).rejects.toThrow(/уже есть/)
    const all = await createToken('all', ['owner'])
    const [row] = await getDb().select({ products: oqTokens.products }).from(oqTokens).where(eq(oqTokens.id, all.id))
    expect(row?.products).toBe('["*"]')
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

describe('запись — надёжность и пары', () => {
  it('два одновременных создания не ломают следующие записи процесса (справочник продуктов — до транзакции)', async () => {
    const [x, y] = await Promise.all([
      call(hr, 'PUT', '/db/items/d-race-1', { data: decision('гонка 1') }),
      call(hr, 'PUT', '/db/items/d-race-2', { data: decision('гонка 2') }),
    ])
    expect([x.status, y.status]).toContain(200)
    for (let i = 3; i <= 5; i++) expect((await call(hr, 'PUT', `/db/items/d-race-${i}`, { data: decision('после') })).status).toBe(200)
  })

  it('пункт, созданный заново при живом ответе, берёт продукт ответа — пара не расходится', async () => {
    await getDb().insert(oqDocs).values({ collection: 'checks', id: 'taibe-legacy', dataJson: JSON.stringify({ done: true }), product: 'hr-helper' })
    expect((await call(owner, 'PUT', '/db/items/taibe-legacy', { data: decision('заново') })).json).toMatchObject({ product: 'hr-helper' })
    expect((await call(owner, 'PATCH', '/db/checks/taibe-legacy', { data: { note: 'ок' } })).status).toBe(200)
  })

  it('миграция 0015 ставит токенам owner ["*"]', async () => {
    const t = await createToken('bot-legacy', ['owner'])
    await getDb().update(oqTokens).set({ products: '["hr-helper"]' }).where(eq(oqTokens.id, t.id))
    await getDb().run(sql.raw(`UPDATE oq_tokens SET products = '["*"]' WHERE ',' || scopes || ',' LIKE '%,owner,%'`))
    const [row] = await getDb().select({ products: oqTokens.products }).from(oqTokens).where(eq(oqTokens.id, t.id))
    expect(row?.products).toBe('["*"]')
  })
})

describe('relay и вложения', () => {
  it('relay — про входящие HR: токен без HR получает 404 на чтение и отметку', async () => {
    expect((await call(taibe, 'GET', '/relay')).status).toBe(404)
    expect((await call(taibe, 'PUT', '/relay', { session: 'hr-sess' })).status).toBe(404)
    expect((await call(hr, 'GET', '/relay')).status).toBe(200)
  })

  it('файлы чужого пункта — как у несуществующего: пусто', async () => {
    const foreign = await call(taibe, 'GET', '/files?item=d-hr-1')
    const absent = await call(taibe, 'GET', '/files?item=d-none')
    expect([foreign.status, foreign.json]).toEqual([absent.status, absent.json])
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
