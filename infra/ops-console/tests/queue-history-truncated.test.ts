// Q-36: событие журнала длиннее 20 000 символов не ломает /history — запись пишет валидный маркер, чтение битой строки
// (старый срез посередине JSON) отдаёт маркер, остальные события — целиком.
import { beforeEach, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { oqEvents } from '../server/db/schema'
import { EVENT_JSON_MAX, docHistory, eventAfter, eventJson, logEvent } from '../server/queue/store'

describe('журнал очереди: длинное и битое событие (Q-36)', () => {
  it('eventJson: до потолка — JSON целиком, длиннее — валидный маркер с длиной', () => {
    expect(eventJson(undefined)).toBeNull()
    expect(eventJson({ pr: 5 })).toBe('{"pr":5}')
    const big = { x: 'я'.repeat(EVENT_JSON_MAX + 5_000) }
    const s = eventJson(big) as string
    expect(JSON.parse(s)).toEqual({ truncated: true, len: JSON.stringify(big).length })
  })

  it('eventAfter: битая строка — маркер, а не исключение', () => {
    expect(eventAfter(null)).toBeNull()
    expect(eventAfter('{"pr":5}')).toEqual({ pr: 5 })
    expect(eventAfter('{"x":"abc')).toEqual({ truncated: true, len: 9 })
  })

  describe('docHistory', () => {
    beforeEach(async () => {
      await freshApp()
    })

    it('событие 25 КБ и битая строка — история читается, соседнее событие целиком', async () => {
      await logEvent('agent', 'items', 'd-big', 'merge', { pr: 1 }, null)
      await logEvent('agent', 'items', 'd-big', 'merge', { x: 'я'.repeat(25_000) }, null)
      await getDb().insert(oqEvents).values({ actor: 'agent', collection: 'items', docId: 'd-big', action: 'merge', afterJson: '{"x":"abc', product: null })
      const events = (await docHistory('items', 'd-big', '*')) as Array<{ after: unknown }>
      expect(events).toHaveLength(3)
      const afters = events.map((e) => e.after)
      expect(afters).toContainEqual({ pr: 1 })
      expect(afters).toContainEqual({ truncated: true, len: 9 })
      expect(afters.filter((a) => (a as { truncated?: boolean }).truncated)).toHaveLength(2)
    })
  })
})
