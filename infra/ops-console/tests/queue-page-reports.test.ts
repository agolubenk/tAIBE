/**
 * «Ход работ» и «Отчёты» страницы /queue без вшитых снимков 15–16.10 (REPORTS_JS, page-reports.ts): строки плана только
 * из базы, направления только со строками, шкала очереди от первого пункта, PR из GET /api/oq/v1/prs. Скрипт — строка,
 * исполняется в vm с подделкой window, document, fetch и setInterval.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { REPORTS_JS } from '../server/queue/page-reports'
import { queuePageBuild } from '../server/queue/page'

type Row = Record<string, unknown> & { id: string }
type Pr = { n: number; title: string; opened: string; merged: string | null; ours: boolean }
type Reports = {
  planRows: (db: Record<string, Record<string, unknown>>, seed: Row[], track: Record<string, { i: number }>) => Row[]
  tracksIn: (tracks: { id: string }[], ws: { track: string }[]) => { id: string }[]
  earliestDay: (dates: unknown[], t: Date) => Date
  prPoints: (prs: Pr[], now: Date) => { pts: { n: number; h: number; open: boolean; ours: boolean }[]; merged7: number; median: number }
  loadPrs: () => void
  prs: () => null | { prs: Pr[]; none?: boolean; error?: string }
  onPrs: (cb: () => void) => void
}
type Res = { status: number; ok: boolean; headers: { get: (k: string) => string | null }; json: () => Promise<unknown> }

function load(fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<Res> = async () => res(200, { prs: [] })) {
  const win: { __oqReports?: Reports } = {}
  const doc = { hidden: false }
  const fetch = vi.fn(fetchImpl)
  const setInterval = vi.fn()
  runInNewContext(REPORTS_JS, { window: win, document: doc, fetch, setInterval, Date, Promise })
  return { r: win.__oqReports!, fetch, doc, setInterval }
}
function res(status: number, body: unknown, etag = ''): Res {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k === 'ETag' ? etag : null) }, json: async () => body }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

const SEED: Row[] = [
  { id: 'w-disk', track: 'tails', order: 1, title: 'Диск', status: 'done', note: 'Снимок 15.10' },
  { id: 'w-bot', track: 'ops', order: 3, title: 'Бот', status: 'planned', planEnd: '2026-10-24' },
]
const TRACK = { tails: { i: 0 }, ops: { i: 1 }, taibe: { i: 2 } }

describe('строки плана — только из базы', () => {
  it('строки вшитого плана без строки базы не показываются; пометки «снимок 16.10» нет', () => {
    const { r } = load()
    const ws = r.planRows({ 'w-disk': { status: 'doing' } }, SEED, TRACK)
    expect(ws.map((w) => w.id)).toEqual(['w-disk'])
    expect(JSON.stringify(ws)).not.toContain('снимок 16.10')
  })

  it('вшитая строка — значения по умолчанию под полями базы с тем же id', () => {
    const { r } = load()
    const [w] = r.planRows({ 'w-disk': { status: 'doing', note: 'новая заметка' } }, SEED, TRACK)
    expect(w).toMatchObject({ id: 'w-disk', title: 'Диск', track: 'tails', order: 1, status: 'doing', note: 'новая заметка' })
  })

  it('база не ответила или пуста — строк нет; архивные, без названия и с неизвестным направлением — отброшены', () => {
    const { r } = load()
    expect(r.planRows({}, SEED, TRACK)).toEqual([])
    const ws = r.planRows({
      a: { title: 'A', track: 'ops', order: 2 }, b: { title: 'B', track: 'tails', order: 5 }, c: { title: 'C', track: 'ops', archived: true },
      d: { track: 'ops' }, e: { title: 'E', track: 'nope' }, 'taibe-1': { title: 'T', track: 'taibe' },
    }, SEED, TRACK)
    expect(ws.map((w) => w.id)).toEqual(['b', 'a', 'taibe-1'])
  })
})

describe('направления и шкала', () => {
  it('направления — только со строками: базовые направления HR у другого продукта не видны', () => {
    const { r } = load()
    const tracks = [{ id: 'tails' }, { id: 'ops' }, { id: 'taibe' }]
    expect(r.tracksIn(tracks, [{ track: 'taibe' }]).map((t) => t.id)).toEqual(['taibe'])
    expect(r.tracksIn(tracks, [])).toEqual([])
  })

  it('шкала очереди — от первого пункта, не от 11.10; без пунктов и с будущей датой — сегодня', () => {
    const { r } = load()
    const t = new Date(2026, 10, 8)
    expect(+r.earliestDay(['2026-11-03T10:00:00Z', '2026-11-05', null], t)).toBe(+new Date(2026, 10, 3))
    expect(+r.earliestDay([], t)).toBe(+t)
    expect(+r.earliestDay(['2026-12-01', 'мусор'], t)).toBe(+t)
  })
})

describe('PR из GitHub', () => {
  const now = new Date('2026-11-08T12:00:00Z')
  it('часы до мёржа, открытый ждёт до сейчас, медиана — по влитым за 7 дней', () => {
    const { r } = load()
    const p = r.prPoints([
      { n: 1, title: 'a', opened: '2026-11-07T10:00:00Z', merged: '2026-11-07T12:00:00Z', ours: true },
      { n: 2, title: 'b', opened: '2026-11-06T12:00:00Z', merged: '2026-11-07T00:00:00Z', ours: false },
      { n: 3, title: 'c', opened: '2026-11-08T06:00:00Z', merged: null, ours: false },
      { n: 4, title: 'd', opened: '2026-10-20T00:00:00Z', merged: '2026-10-21T00:00:00Z', ours: false },
      { n: 5, title: 'e', opened: 'мусор', merged: null, ours: false },
    ], now)
    expect(p.pts.map((x) => [x.n, x.h, x.open, x.ours])).toEqual([[1, 2, false, true], [2, 12, false, false], [3, 6, true, false], [4, 24, false, false]])
    expect(p.merged7).toBe(2)
    expect(p.median).toBe(7)
    expect(r.prPoints([], now)).toEqual({ pts: [], merged7: 0, median: 0 })
  })

  it('загрузка: ответ — данные и перерисовка; повтор раньше 5 минут не идёт; 304 — с тегом, данные прежние', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
      const answers = [res(200, { prs: [{ n: 9 }] }, 'W/"prs-1"'), res(304, null)]
      const { r, fetch, setInterval } = load(async () => answers.shift()!)
      const changed = vi.fn()
      r.onPrs(changed)
      expect(setInterval).toHaveBeenCalledWith(r.loadPrs, 3e5)
      expect(r.prs()).toBeNull()
      r.loadPrs()
      await flush()
      expect(r.prs()).toEqual({ prs: [{ n: 9 }] })
      expect(changed).toHaveBeenCalledTimes(1)
      r.loadPrs()
      expect(fetch).toHaveBeenCalledTimes(1)
      vi.setSystemTime(new Date('2026-11-08T12:05:00Z'))
      r.loadPrs()
      await flush()
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[1]![1].headers).toEqual({ 'If-None-Match': 'W/"prs-1"' })
      expect(r.prs()).toEqual({ prs: [{ n: 9 }] })
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('404 — у токена нет HR: «none», больше не спрашивает; сбой сети до первого ответа — причина', async () => {
    const a = load(async () => res(404, {}))
    a.r.loadPrs()
    await flush()
    expect(a.r.prs()).toEqual({ prs: [], none: true })
    const b = load(async () => { throw new Error('offline') })
    b.r.loadPrs()
    await flush()
    expect(b.r.prs()).toEqual({ prs: [], error: 'нет связи' })
  })

  it('вкладка в фоне — не спрашивает', () => {
    const { r, fetch, doc } = load()
    doc.hidden = true
    r.loadPrs()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('страница без вшитых снимков отчётов', () => {
  const html = readFileSync(join(__dirname, '../server/queue/page.html'), 'utf8')
  it('нет списка PR на 15.10, пометки «снимок 16.10» у строк плана и старта шкалы 11.10', () => {
    expect(html).not.toMatch(/var PRS = \[/)
    expect(html).not.toMatch(/var OURS = /)
    expect(html).not.toContain('(снимок 16.10)')
    expect(html).not.toContain("dParse('2026-10-11')")
    expect(html).not.toContain('План от 15.10')
  })

  it('скрипт данных «Хода работ» — до кода страницы', () => {
    const { html: page } = queuePageBuild()
    const at = (name: string) => page.indexOf(`/queue/assets/${name}.`)
    expect(at('reports')).toBeGreaterThan(0)
    expect(at('reports')).toBeLessThan(at('page'))
  })
})
