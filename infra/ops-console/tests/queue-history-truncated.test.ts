// Q-36: событие длиннее предела журнала не роняет историю документа — /history отвечает 200, остальные события
// приходят целиком. Запись хранит валидный маркер обрезки; событие старого образа с разрезанным JSON читается маркером.
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { EVENT_AFTER_MAX, eventAfterJson, logEvent } from '../server/queue/store'
import { getDb } from '../server/db/client'
import { oqEvents } from '../server/db/schema'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let agent: string

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('q36-agent', ['read', 'agent'])).token
})

// ≈ 26 КБ JSON: строка work с ~200 карточками — выше предела 20 000 символов.
const big = { title: 'Работа', cards: Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, title: `Карточка ${i} ${'x'.repeat(100)}` })) }

describe('eventAfterJson — after события всегда валидный JSON', () => {
  it('короткий документ — как есть; undefined — null', () => {
    expect(eventAfterJson({ a: 1 })).toBe('{"a":1}')
    expect(eventAfterJson(undefined)).toBeNull()
  })

  it('документ длиннее предела — маркер с длиной и началом, в пределе', () => {
    const full = JSON.stringify(big)
    expect(full.length).toBeGreaterThan(25_000)
    const json = eventAfterJson(big)!
    expect(json.length).toBeLessThanOrEqual(EVENT_AFTER_MAX)
    const marker = JSON.parse(json)
    expect(marker).toMatchObject({ truncated: true, afterLen: full.length })
    expect(full.startsWith(marker.head)).toBe(true)
    expect(marker.head.length).toBe(8_000)
  })

  it('худший случай экранирования (кавычки и обратные косые) — маркер всё равно в пределе', () => {
    const json = eventAfterJson({ s: '"\\'.repeat(20_000) })!
    expect(json.length).toBeLessThanOrEqual(EVENT_AFTER_MAX)
    expect(JSON.parse(json).truncated).toBe(true)
  })
})

describe('/history с событием длиннее предела', () => {
  it('200; маленькие события целиком, большое — маркером, старое обрезанное — маркером с началом', async () => {
    const doc = 'w-q36'
    await logEvent('token:a', 'work', doc, 'put', { step: 1 }, null)
    await logEvent('token:a', 'work', doc, 'patch', big, null)
    // Так писал журнал до Q-36: JSON, разрезанный на 20 000 символов.
    const legacy = JSON.stringify(big).slice(0, 20_000)
    await getDb().insert(oqEvents).values({ actor: 'token:legacy', collection: 'work', docId: doc, action: 'patch', afterJson: legacy, product: null })
    await logEvent('token:a', 'work', doc, 'patch', { step: 3 }, null)

    const res = await app.request(`/api/oq/v1/history/work/${doc}`, { headers: { Authorization: `Bearer ${agent}` } })
    expect(res.status).toBe(200)
    const { events } = (await res.json()) as { events: { actor: string; after: Record<string, unknown> }[] }
    expect(events).toHaveLength(4)
    const afters = events.map((e) => e.after)
    expect(afters).toContainEqual({ step: 1 })
    expect(afters).toContainEqual({ step: 3 })
    expect(afters).toContainEqual(expect.objectContaining({ truncated: true, afterLen: JSON.stringify(big).length }))
    const old = events.find((e) => e.actor === 'token:legacy')!
    expect(old.after).toEqual({ truncated: true, head: legacy.slice(0, 8_000) })
  })
})
