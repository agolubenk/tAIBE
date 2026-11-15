// История документа для агентов (карточка HR oow56fdzk): ?limit=, ?before= (next), ?fields=meta. Без параметров — как
// раньше: 50 событий со снимками after (их читает синхронизация досок, forest/owner-queue/sync-pass.ts).
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { logEvent } from '../server/queue/store'
import { getDb } from '../server/db/client'
import { oqEvents } from '../server/db/schema'

type App = Awaited<ReturnType<typeof freshApp>>
type Ev = { at: number; actor: string; action: string; after?: Record<string, unknown>; keys?: string[] | null }
let app: App
let agent: string
let owner: string
const DOC = 'd-hist-limit'

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('hist-agent', ['read', 'agent'])).token
  owner = (await createToken('hist-owner', ['owner'])).token
  // 55 правок: тело по 12 000 символов (потолок body пункта), шаг меняет поле step, каждая пятая — ещё и title.
  for (let i = 0; i < 55; i++) {
    await logEvent('token:a', 'items', DOC, 'update', { title: `пункт ${Math.floor(i / 5)}`, body: 'т'.repeat(12_000), step: i }, null)
  }
})

const get = async (q = '') => {
  const res = await app.request(`/api/oq/v1/history/items/${DOC}${q}`, { headers: { Authorization: `Bearer ${agent}` } })
  return { status: res.status, text: await res.clone().text(), json: (await res.json()) as { events: Ev[]; next?: string; error?: string } }
}

describe('/history: limit, before, fields=meta', () => {
  it('без параметров — 50 событий со снимками, как раньше; next — есть старше', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.json.events).toHaveLength(50)
    expect(r.json.events[0]!.after).toMatchObject({ step: 54 })
    expect(typeof r.json.next).toBe('string')
  })

  it('limit=5 — 5 свежих; before=next — следующие 5 без пропусков и повторов; последняя страница — без next', async () => {
    const a = await get('?limit=5')
    expect(a.json.events.map((e) => e.after!.step)).toEqual([54, 53, 52, 51, 50])
    const b = await get(`?limit=5&before=${a.json.next}`)
    expect(b.json.events.map((e) => e.after!.step)).toEqual([49, 48, 47, 46, 45])
    const all: number[] = []
    let next: string | undefined
    do {
      const p = await get(`?limit=20${next ? `&before=${next}` : ''}`)
      all.push(...p.json.events.map((e) => e.after!.step as number))
      next = p.json.next
    } while (next)
    expect(all).toEqual(Array.from({ length: 55 }, (_, i) => 54 - i))
  })

  it('fields=meta — без after, keys — изменённые поля; 50 событий с телом по 12 000 символов меньше 20 КБ', async () => {
    const r = await get('?limit=50&fields=meta')
    expect(r.json.events).toHaveLength(50)
    expect(r.json.events.every((e) => e.after === undefined)).toBe(true)
    expect(r.json.events[0]!.keys).toEqual(['step']) // step 54 против 53
    expect(r.json.events[4]!.keys).toEqual(['step', 'title']) // step 50 — новый title против step 49
    expect(r.text.length).toBeLessThan(20_000)
    expect((await get('?limit=50')).text.length).toBeGreaterThan(500_000)
    // Самое старое событие документа — все его поля.
    const last = await get(`?limit=5&fields=meta&before=${(await get('?limit=50')).json.next}`)
    expect(last.json.events.at(-1)!.keys).toEqual(['body', 'step', 'title'])
  })

  it('fields=meta рядом с merge и product (у них в after не снимок документа): keys — между снимками, у merge и product — null (линза Claude #360, B1)', async () => {
    const doc = 'd-hist-mixed'
    await logEvent('token:a', 'items', doc, 'set', { title: 'Т', body: 'б', step: 1 }, null)
    await logEvent('owner', 'items', doc, 'merge', { pr: 7, sha: 'a'.repeat(40), method: 'squash' }, null)
    await logEvent('owner', 'items', doc, 'product', { from: 'hr-helper', to: 'taibe', reason: 'x' }, null)
    await logEvent('token:a', 'items', doc, 'update', { title: 'Т', body: 'б', step: 2 }, null)
    const r = await (await app.request(`/api/oq/v1/history/items/${doc}?fields=meta`, { headers: { Authorization: `Bearer ${agent}` } })).json() as { events: Ev[] }
    expect(r.events.map((e) => [e.action, e.keys])).toEqual([
      ['update', ['step']],
      ['product', null],
      ['merge', null],
      ['set', ['body', 'step', 'title']],
    ])
    // Окно обрезало старший снимок, а за окном — merge: сравнить не с чем, null, а не ложный список.
    const w = await (await app.request(`/api/oq/v1/history/items/${doc}?fields=meta&limit=1`, { headers: { Authorization: `Bearer ${agent}` } })).json() as { events: Ev[] }
    expect(w.events[0]!.keys).toBeNull()
  })

  it('негодные параметры — 400 с причиной', async () => {
    for (const q of ['?limit=0', '?limit=101', '?limit=x', '?before=-1', '?fields=all']) {
      const r = await get(q)
      expect(r.status, q).toBe(400)
    }
  })
})

const getAs = async (tok: string, doc: string, q = '') => {
  const res = await app.request(`/api/oq/v1/history/items/${doc}${q}`, { headers: { Authorization: `Bearer ${tok}` } })
  return (await res.json()) as { events: Ev[]; next?: string }
}

describe('/history: курсор и схлопывание пар product (линза backend #360)', () => {
  it('M1: пара product в окне у владельца (видит оба продукта) — next всё равно есть, старшие события доступны', async () => {
    const doc = 'd-hist-pair'
    for (const step of [1, 2, 3]) await logEvent('token:a', 'items', doc, 'patch', { step }, null)
    // Смена продукта: одно событие в оба продукта — одно время, автор и снимок.
    const at = new Date()
    const after = JSON.stringify({ step: 3, moved: true })
    await getDb().insert(oqEvents).values([
      { at, actor: 'bot', collection: 'items', docId: doc, action: 'product', afterJson: after, product: 'hr-helper' },
      { at, actor: 'bot', collection: 'items', docId: doc, action: 'product', afterJson: after, product: 'taibe' },
    ])
    await logEvent('token:a', 'items', doc, 'patch', { step: 4 }, null)
    const p1 = await getAs(owner, doc, '?limit=3')
    expect(p1.events.map((e) => e.action)).toEqual(['patch', 'product'])
    expect(typeof p1.next).toBe('string')
    const p2 = await getAs(owner, doc, `?limit=3&before=${p1.next}`)
    expect(p2.events.map((e) => e.after!.step)).toEqual([3, 2, 1])
    expect(p2.next).toBeUndefined()
  })

  it('M2: часы шагнули назад (at не растёт с номером события) — постранично ни одно событие не теряется', async () => {
    const doc = 'd-hist-clock'
    const t0 = Date.now()
    for (const [step, dt] of [[1, 0], [2, 200_000], [3, 100_000]] as const) {
      await getDb().insert(oqEvents).values({ at: new Date(t0 + dt), actor: 'token:a', collection: 'items', docId: doc, action: 'patch', afterJson: JSON.stringify({ step }), product: null })
    }
    const seen: number[] = []
    let next: string | undefined
    do {
      const p = await getAs(agent, doc, `?limit=1${next ? `&before=${next}` : ''}`)
      seen.push(...p.events.map((e) => e.after!.step as number))
      next = p.next
    } while (next)
    expect(seen).toEqual([3, 2, 1])
  })
})
