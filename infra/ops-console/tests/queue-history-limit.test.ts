// История документа для агентов (карточка HR oow56fdzk): ?limit=, ?before= (next), ?fields=meta. Без параметров — как
// раньше: 50 событий со снимками after (их читает синхронизация досок, forest/owner-queue/sync-pass.ts).
import { beforeAll, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { createToken } from '../server/queue/auth'
import { logEvent } from '../server/queue/store'

type App = Awaited<ReturnType<typeof freshApp>>
type Ev = { at: number; actor: string; action: string; after?: Record<string, unknown>; keys?: string[] | null }
let app: App
let agent: string
const DOC = 'd-hist-limit'

beforeAll(async () => {
  app = await freshApp()
  agent = (await createToken('hist-agent', ['read', 'agent'])).token
  // 55 правок: тело по 12 000 символов (потолок body пункта), шаг меняет поле step, каждая пятая — ещё и title.
  for (let i = 0; i < 55; i++) {
    await logEvent('token:a', 'items', DOC, 'patch', { title: `пункт ${Math.floor(i / 5)}`, body: 'т'.repeat(12_000), step: i }, null)
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

  it('негодные параметры — 400 с причиной', async () => {
    for (const q of ['?limit=0', '?limit=101', '?limit=x', '?before=-1', '?fields=all']) {
      const r = await get(q)
      expect(r.status, q).toBe(400)
    }
  })
})
