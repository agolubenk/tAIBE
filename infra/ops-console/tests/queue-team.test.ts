/**
 * Состояние команды ролей Mac (queue/team.ts, OPS-82): сторож Mac отмечается PUT /team раз в 10 мин, кнопка «Роли» в
 * шапке /queue читает GET /team. Настройка, а не документ очереди: отметка не меняет ETag списка work и не пишет журнал.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let agent: string
let reader: string

async function call(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/api/oq/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, etag: res.headers.get('ETag'), json: (text ? JSON.parse(text) : null) as Record<string, any> }
}

const BEAT = {
  item: 'd-team-split', total: 12, split: [['hr-helper', 6], ['taibe', 6]], alloc: [['hr-helper', 6], ['taibe', 6]],
  max: [['hr-helper', 8], ['taibe', 8]], src: 'очередь', want: 12, live: 11, extra: 0, cap: 12, mem: 34.5, pause: '', hold: '',
}

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('team-agent', ['read', 'agent'])).token
  reader = (await createToken('team-reader', ['read'])).token
})

describe('PUT/GET /team', () => {
  it('до первой отметки — пусто; отметка — с временем сервера и именем токена', async () => {
    expect((await call(reader, 'GET', '/team')).json).toEqual({})
    const before = Date.now()
    const put = await call(agent, 'PUT', '/team', { ...BEAT, at: '2000-01-01T00:00:00Z' })
    expect(put.status).toBe(200)
    const got = (await call(reader, 'GET', '/team')).json
    expect(got).toMatchObject({ ...BEAT, by: 'token:team-agent' })
    expect(Date.parse(got.at)).toBeGreaterThanOrEqual(before - 1000) // часам Mac не верим
  })
  it('отметка не меняет ETag списка work и не пишет журнал документов', async () => {
    const tag = (await call(reader, 'GET', '/db/work')).etag
    await call(agent, 'PUT', '/team', { ...BEAT, live: 12 })
    expect((await call(reader, 'GET', '/db/work', undefined, tag ? { 'If-None-Match': tag } : {})).status).toBe(304)
  })
  it('сбой сторожа: числа null; читатель не отмечается; чужие поля и размеры — 400', async () => {
    expect((await call(agent, 'PUT', '/team', { ...BEAT, want: null, live: null, extra: null, hold: 'сбой сторожа Mac' })).status).toBe(200)
    expect((await call(reader, 'GET', '/team')).json.live).toBeNull()
    expect((await call(reader, 'PUT', '/team', BEAT)).status).toBe(403)
    expect((await call(agent, 'PUT', '/team', { ...BEAT, pause: 'всегда' })).status).toBe(400)
    expect((await call(agent, 'PUT', '/team', { ...BEAT, hold: 'x'.repeat(301) })).status).toBe(400)
    expect((await call(agent, 'PUT', '/team', { ...BEAT, split: [['HR Helper', 6]] })).status).toBe(400)
    expect((await call(agent, 'PUT', '/team', { ...BEAT, item: 'a b' })).status).toBe(400)
    expect((await call(agent, 'PUT', '/team', { ...BEAT, seen: false })).status).toBe(200)
    expect((await call(reader, 'GET', '/team')).json.seen).toBe(false)
  })
})
