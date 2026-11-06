/**
 * Список коллекции очереди: потолок с видимой обрезкой, gzip ответа и 304 по слабому ETag (фаза 0 быстрого пути,
 * docs/plans/roadmap/owner-queue-multi-product.md в HR). Раньше limit(2000) молча обрезал checks.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { etagMatches } from '../server/queue/etag'
import { setListLimitsForTests } from '../server/queue/store'

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
  setListLimitsForTests(null)
  vi.restoreAllMocks()
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
    // ?open=1 — тот же путь: тег сжатого ответа даёт 304.
    const open = await get('/db/items?open=1', { 'Accept-Encoding': 'gzip' })
    expect(open.headers.get('content-encoding')).toBe('gzip')
    await gunzip(open)
    expect((await get('/db/items?open=1', { 'If-None-Match': open.headers.get('etag')! })).status).toBe(304)
  })

  it('без Accept-Encoding — прежний ответ: без сжатия, сильный тег, только docs', async () => {
    const res = await get('/db/items')
    expect(res.headers.get('content-encoding')).toBeNull()
    const tag = res.headers.get('etag')!
    expect(tag.startsWith('"')).toBe(true)
    expect(Object.keys((await res.json()) as object)).toEqual(['docs'])
    expect((await get('/db/items', { 'If-None-Match': tag })).status).toBe(304)
  })
})

describe('потолок списка', () => {
  it('обрезка видна: truncated, total, limit — самые свежие документы; старый клиент читает docs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setListLimitsForTests({ max: 3, warn: 2 })
    const res = await get('/db/items')
    const body = (await res.json()) as { docs: { id: string }[]; truncated?: boolean; total?: number; limit?: number }
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(5)
    expect(body.limit).toBe(3)
    expect(body.docs.map((d) => d.id)).toEqual(['d-list-5', 'd-list-4', 'd-list-3'])
    // Тег — тот же, что без потолка: 304 по-прежнему работает.
    expect((await get('/db/items', { 'If-None-Match': res.headers.get('etag')! })).status).toBe(304)
    // ?open=1 — та же форма; total — размер коллекции items.
    const open = (await (await get('/db/items?open=1')).json()) as { open: boolean; truncated?: boolean; total?: number; docs: unknown[] }
    expect(open).toMatchObject({ open: true, truncated: true, total: 5 })
    expect(open.docs.length).toBeLessThanOrEqual(3)
    // Предупреждение о размере — один раз на коллекцию за процесс.
    await get('/db/items')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('коллекция items'))).toHaveLength(1)
  })

  it('коллекция в пределах потолка — без полей обрезки', async () => {
    setListLimitsForTests({ max: 5, warn: 100 })
    const body = (await (await get('/db/items')).json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['docs'])
    expect((body.docs as unknown[]).length).toBe(5)
  })
})
