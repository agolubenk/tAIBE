/**
 * Смена продукта пункта (v2-lite, часть 3, server/queue/product-change.ts) и фильтр списка ?product=: владелец
 * переносит пункт вместе с ответом, сессии прежнего продукта его больше не видят; входящее и вердикт мёржа не
 * переезжают; фильтр — только видимые продукты.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { oqDocs } from '../server/db/schema'
import { createToken } from '../server/queue/auth'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let hr: string
let taibe: string
let owner: string

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/oq/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
  owner = (await createToken('bot', ['owner'])).token
  expect((await call(hr, 'PUT', '/db/items/d-move-1', { data: decision('не тот продукт') })).status).toBe(200)
  expect((await call(hr, 'PATCH', '/db/checks/d-move-1', { data: { agentStatus: 'doing', agentNote: 'начал' } })).status).toBe(200)
})

describe('смена продукта пункта', () => {
  it('владелец переносит пункт и ответ; прежний продукт его не видит, новый — видит; события в обоих', async () => {
    const ownerTag = (await call(owner, 'GET', '/db/items')).etag
    const res = await call(owner, 'POST', '/items/d-move-1/product', { to: 'taibe', reason: 'это задача tAIBE' })
    expect(res.json).toEqual({ id: 'd-move-1', from: 'hr-helper', to: 'taibe', changed: true })
    expect((await call(hr, 'GET', '/db/items/d-move-1')).status).toBe(404)
    expect((await call(hr, 'GET', '/db/checks/d-move-1')).status).toBe(404)
    expect((await call(taibe, 'GET', '/db/items/d-move-1')).json).toMatchObject({ product: 'taibe' })
    expect((await call(taibe, 'GET', '/db/checks/d-move-1')).json).toMatchObject({ product: 'taibe', data: { agentStatus: 'doing' } })
    // Тег владельца меняется: страница видит новый продукт на следующем опросе.
    expect((await call(owner, 'GET', '/db/items')).etag).not.toBe(ownerTag)
    const hist = (r: Awaited<ReturnType<typeof call>>) => (r.json?.events as { action: string }[]).map((e) => e.action)
    expect(hist(await call(hr, 'GET', '/history/items/d-move-1'))).toContain('product')
    expect(hist(await call(taibe, 'GET', '/history/items/d-move-1'))).toEqual(['product'])
    // Владелец видит оба продукта — событие одно; у ответа — своё событие.
    expect(hist(await call(owner, 'GET', '/history/items/d-move-1')).filter((a) => a === 'product')).toHaveLength(1)
    expect(hist(await call(taibe, 'GET', '/history/checks/d-move-1'))).toEqual(['product'])
    // Сессия нового продукта отвечает в перенесённый пункт, прежнего — нет.
    expect((await call(taibe, 'PATCH', '/db/checks/d-move-1', { data: { agentNote: 'продолжаю' } })).status).toBe(200)
    expect((await call(hr, 'PATCH', '/db/checks/d-move-1', { data: { agentNote: 'я тоже' } })).status).toBe(404)
  })

  it('тот же продукт — без изменений; неизвестный продукт — 422; нет пункта — 404; агент — 403', async () => {
    expect((await call(owner, 'POST', '/items/d-move-1/product', { to: 'taibe' })).json).toMatchObject({ changed: false })
    expect((await call(owner, 'POST', '/items/d-move-1/product', { to: 'nope' })).status).toBe(422)
    expect((await call(owner, 'POST', '/items/d-none/product', { to: 'taibe' })).status).toBe(404)
    expect((await call(hr, 'POST', '/items/d-move-1/product', { to: 'hr-helper' })).status).toBe(403)
  })

  it('пункт мёржа с вердиктом «Контроля» не переносится', async () => {
    const verdict = { kind: 'merge', title: 'Влить', pr: 7, sha: 'a'.repeat(40), base: 'main' }
    expect((await call(owner, 'PUT', '/db/items/m-move-7', { data: verdict })).status).toBe(200)
    expect((await call(owner, 'POST', '/items/m-move-7/product', { to: 'taibe' })).status).toBe(409)
    expect((await call(owner, 'PUT', '/db/items/m-move-8', { data: { kind: 'merge', title: 'Влить', pr: 8 } })).status).toBe(200)
    expect((await call(owner, 'POST', '/items/m-move-8/product', { to: 'taibe' })).json).toMatchObject({ changed: true })
  })

  it('входящее не уходит из HR, пока автопередача одна: 409, пункт и захват на месте', async () => {
    const inbox = { kind: 'inbox', title: 'Входящее', inbox: { type: 'task', urgency: 'queue', text: 'текст', originKind: 'self', forwarded: false, receivedAt: '2026-11-07T00:00:00Z' } }
    expect((await call(owner, 'PUT', '/db/items/i-move-1', { data: inbox })).status).toBe(200)
    expect((await call(hr, 'PATCH', '/db/checks/i-move-1', { data: { agentStatus: 'taken', agentBy: 'hr-sess' } })).status).toBe(200)
    expect((await call(owner, 'POST', '/items/i-move-1/product', { to: 'taibe' })).status).toBe(409)
    expect((await call(hr, 'GET', '/db/checks/i-move-1')).json).toMatchObject({ product: 'hr-helper', data: { agentBy: 'hr-sess' } })
  })
})

describe('фильтр списка ?product=', () => {
  it('владелец — один продукт; токен — только из видимых, невидимый — пусто', async () => {
    await getDb().insert(oqDocs).values({ collection: 'items', id: 'lavaeon-d-1', dataJson: JSON.stringify(decision('Lavaeon')), product: 'lavaeon' })
    expect(ids(await call(owner, 'GET', '/db/items?product=lavaeon'))).toEqual(['lavaeon-d-1'])
    expect(ids(await call(owner, 'GET', '/db/items?product=taibe'))).toEqual(['d-move-1', 'm-move-8'])
    expect(ids(await call(taibe, 'GET', '/db/items?product=hr-helper'))).toEqual([])
    expect(ids(await call(hr, 'GET', '/db/items?product=hr-helper'))).toEqual(['i-move-1', 'm-move-7'])
    expect(ids(await call(owner, 'GET', '/db/items?open=1&product=lavaeon'))).toEqual(['lavaeon-d-1'])
    expect((await call(owner, 'GET', '/db/items?product=BAD!')).json?.docs).toEqual([])
  })
})
