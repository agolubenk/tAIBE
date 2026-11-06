/**
 * Список коллекции очереди: потолок с видимой обрезкой, gzip ответа и 304 по слабому ETag (фаза 0 быстрого пути,
 * docs/plans/roadmap/owner-queue-multi-product.md в HR). Прежний limit(2000) обрезал молча.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { etagMatches } from '../server/queue/etag'
import { gzipListOnce } from '../server/queue/list-gzip'
import { setListMaxForTests } from '../server/queue/store'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let agent: string

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`/api/oq/v1${path}`, { headers: { Authorization: `Bearer ${agent}`, ...headers } })

const put = async (id: string, body = 'Текст') => {
  const res = await app.request(`/api/oq/v1/db/items/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { kind: 'decision', title: `Решение ${id}`, body, options: [{ id: 'yes', label: 'Да', hint: 'рекомендую' }], source: 'test' } }),
  })
  expect(res.status).toBe(200)
}

const gunzip = (res: Response) => new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('test-agent', ['read', 'agent'])).token
  // Пауза — разные updatedAt (мс): порядок «самые свежие первыми» в тесте потолка однозначен.
  for (let i = 1; i <= 5; i++) {
    await put(`d-list-${i}`, 'Длинный текст пункта. '.repeat(40))
    await new Promise((r) => setTimeout(r, 3))
  }
})

afterEach(() => {
  setListMaxForTests(null)
})

describe('etagMatches — If-None-Match по RFC 9110 §13.1.2', () => {
  it('слабое сравнение, список и «*»', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true)
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true)
    expect(etagMatches('"x", W/"abc"', '"abc"')).toBe(true)
    expect(etagMatches('*', '"abc"')).toBe(true)
    expect(etagMatches('"abd"', '"abc"')).toBe(false)
    expect(etagMatches('', '"abc"')).toBe(false)
    expect(etagMatches(undefined, '"abc"')).toBe(false)
  })
})

describe('gzip списка и 304 по тегу сжатого ответа', () => {
  it('Accept-Encoding: gzip — сжатый JSON с W/-тегом, повтор с ним — 304', async () => {
    const res = await get('/db/items', { 'Accept-Encoding': 'gzip' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toMatch(/accept-encoding/i)
    const tag = res.headers.get('etag')!
    expect(tag.startsWith('W/"')).toBe(true)
    const body = JSON.parse(await gunzip(res)) as { docs: { id: string }[] }
    expect(body.docs.map((d) => d.id)).toContain('d-list-3')

    const again = await get('/db/items', { 'Accept-Encoding': 'gzip', 'If-None-Match': tag })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    // 304 — с теми же ETag и Vary, что у 200 (RFC 9110 §15.4.5).
    expect(again.headers.get('etag')).toBe(tag)
    expect(again.headers.get('vary')).toMatch(/accept-encoding/i)
    // ?open=1 — тот же путь: тег сжатого ответа даёт 304.
    const open = await get('/db/items?open=1', { 'Accept-Encoding': 'gzip' })
    expect(open.headers.get('content-encoding')).toBe('gzip')
    await gunzip(open)
    expect((await get('/db/items?open=1', { 'If-None-Match': open.headers.get('etag')! })).status).toBe(304)
  })

  it('без Accept-Encoding — без сжатия, только docs; тег тот же, что у сжатого ответа', async () => {
    const res = await get('/db/items')
    expect(res.headers.get('content-encoding')).toBeNull()
    const tag = res.headers.get('etag')!
    expect(tag).toBe((await get('/db/items', { 'Accept-Encoding': 'gzip' })).headers.get('etag'))
    expect(Object.keys((await res.json()) as object)).toEqual(['docs'])
    expect((await get('/db/items', { 'If-None-Match': tag })).status).toBe(304)
  })
})

describe('потолок списка', () => {
  it('обрезка видна: truncated, total, limit — самые свежие документы; старый клиент читает docs', async () => {
    const before = (await get('/db/items')).headers.get('etag')!
    setListMaxForTests(3)
    const res = await get('/db/items')
    const body = (await res.json()) as { docs: { id: string }[]; truncated?: boolean; total?: number; limit?: number }
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(5)
    expect(body.limit).toBe(3)
    expect(body.docs.map((d) => d.id)).toEqual(['d-list-5', 'd-list-4', 'd-list-3'])
    // Потолок — в теге: клиент со списком под прежним потолком получает 200, а не 304 со старым списком.
    expect(res.headers.get('etag')).not.toBe(before)
    expect((await get('/db/items', { 'If-None-Match': before })).status).toBe(200)
    expect((await get('/db/items', { 'If-None-Match': res.headers.get('etag')! })).status).toBe(304)
    // ?open=1 — та же форма; total — размер коллекции items.
    const open = (await (await get('/db/items?open=1')).json()) as { open: boolean; truncated?: boolean; total?: number; docs: unknown[] }
    expect(open).toMatchObject({ open: true, truncated: true, total: 5 })
    expect(open.docs.length).toBeLessThanOrEqual(3)
  })

  it('коллекция в пределах потолка — без полей обрезки', async () => {
    setListMaxForTests(5)
    const body = (await (await get('/db/items')).json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['docs'])
    expect((body.docs as unknown[]).length).toBe(5)
  })
})

describe('сжатый список — одна сборка на тег', () => {
  it('одновременные запросы с одним тегом ждут одну сборку; новый тег — новая сборка; сбой не кэшируется', async () => {
    let builds = 0
    const build = async () => ({ docs: [{ id: `b-${++builds}` }] })
    const [a, b] = await Promise.all([gzipListOnce('t-key', 'W/"1"', build), gzipListOnce('t-key', 'W/"1"', build)])
    expect(builds).toBe(1)
    expect(a).toBe(b)
    await gzipListOnce('t-key', 'W/"1"', build)
    expect(builds).toBe(1)
    await gzipListOnce('t-key', 'W/"2"', build)
    expect(builds).toBe(2)

    await expect(gzipListOnce('t-fail', 'W/"1"', async () => { throw new Error('сбой') })).rejects.toThrow('сбой')
    await new Promise((r) => setTimeout(r, 0))
    await gzipListOnce('t-fail', 'W/"1"', build)
    expect(builds).toBe(3)
  })

  it('после записи сжатый ответ — новый список, а не кэш прежнего тега', async () => {
    const first = await get('/db/items', { 'Accept-Encoding': 'gzip' })
    const before = JSON.parse(await gunzip(first)) as { docs: { id: string }[] }
    await put('d-list-6')
    const after = await get('/db/items', { 'Accept-Encoding': 'gzip' })
    expect(after.headers.get('etag')).not.toBe(first.headers.get('etag'))
    const docs = (JSON.parse(await gunzip(after)) as { docs: { id: string }[] }).docs.map((d) => d.id)
    expect(docs).toContain('d-list-6')
    expect(docs.length).toBe(before.docs.length + 1)
  })
})
