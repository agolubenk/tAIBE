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
  dailyCounts: (dates: unknown[], start: Date, n: number) => number[]
  medianForecast: (counts: number[], win: number, ahead: number) => number[]
  datedCount: (dates: unknown[]) => number
  meanForecast: (counts: number[], win: number, ahead: number) => number[]
  replan: (done: number, total: number, rate: number, maxDays: number) => { days: number | null; vals: number[] }
  FORECAST_MIN: number
  prCap: (pts: { h: number }[], niceMax: (v: number) => number) => { ymax: number; cap: number; over: number }
  splitByProduct: <T>(rows: T[], productOf: (r: T) => string | undefined) => Record<string, number>
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

describe('правая ось очереди: пунктов за день и медиана с прогнозом', () => {
  const { r } = load()
  const start = new Date(2026, 10, 1)
  it('счёт по дням; раньше начала — в первый день; без даты (вшитые пункты) и позже шкалы — не в счёт', () => {
    const c = r.dailyCounts(['2026-11-01T10:00:00Z', '2026-11-03', '2026-11-03T23:00:00', 'нет даты', '', '2026-10-20', '2026-12-01'], start, 4)
    expect(c).toEqual([2, 0, 2, 0])
    expect(r.dailyCounts([], start, 0)).toEqual([])
  })
  it('скользящая медиана за окно с текущим днём, дальше — последнее значение ahead дней', () => {
    expect(r.medianForecast([1, 3, 2, 8], 3, 2)).toEqual([1, 2, 2, 3, 3, 3])
    expect(r.medianForecast([0, 0, 4, 4], 4, 1)).toEqual([0, 0, 0, 2, 2])
    expect(r.medianForecast([], 14, 3)).toEqual([0, 0, 0])
  })
})

describe('«Задачи агентов: план и факт» — темп, прогноз и пересчитанный план', () => {
  const { r } = load()
  it('прогноз — от 7 дат; без даты — не в счёт', () => {
    expect(r.FORECAST_MIN).toBe(7)
    expect(r.datedCount(['2026-11-01', '2026-11-02T10:00:00Z', '', null, 'нет даты', undefined])).toBe(2)
  })
  it('скользящее среднее за окно с текущим днём, дальше — последнее значение ahead дней; редкие закрытия — не ноль', () => {
    expect(r.meanForecast([2, 0, 4], 2, 2)).toEqual([2, 1, 2, 2, 2])
    // Медиана такого ряда — 0 (закрытия пачками), среднее — 3/7.
    const sparse = [0, 0, 3, 0, 0, 0, 0]
    expect(r.medianForecast(sparse, 7, 0).at(-1)).toBe(0)
    expect(r.meanForecast(sparse, 7, 0).at(-1)).toBeCloseTo(3 / 7)
    expect(r.meanForecast([], 14, 2)).toEqual([0, 0])
  })
  it('пересчитанный план: от сделанного до всего объёма с темпом; срок — дней до конца', () => {
    expect(r.replan(4, 10, 2, 180)).toEqual({ days: 3, vals: [4, 6, 8, 10] })
    // Последний шаг не перескакивает объём.
    expect(r.replan(0, 5, 2, 180)).toEqual({ days: 3, vals: [0, 2, 4, 5] })
  })
  it('всё готово — срок 0; темпа нет — срока нет и линии нет; дольше потолка — линия до потолка без срока', () => {
    expect(r.replan(10, 10, 1, 180)).toEqual({ days: 0, vals: [10] })
    expect(r.replan(3, 10, 0, 180)).toEqual({ days: null, vals: [3] })
    const far = r.replan(0, 100, 0.1, 30)
    expect(far.days).toBeNull()
    expect(far.vals).toHaveLength(31)
    expect(far.vals.at(-1)).toBeCloseTo(3)
  })
})

describe('шкала PR — до 36 ч, выше — на верхней линии', () => {
  const { r } = load()
  const nice = (v: number) => (v <= 4 ? 4 : v <= 5 ? 5 : v <= 10 ? 10 : v <= 20 ? 20 : v <= 25 ? 25 : 50)
  it('без выбросов — своя шкала, но не выше 36', () => {
    expect(r.prCap([{ h: 1 }, { h: 3 }], nice)).toEqual({ ymax: 4, cap: 36, over: 0 })
    expect(r.prCap([{ h: 18 }], nice)).toEqual({ ymax: 20, cap: 36, over: 0 })
    expect(r.prCap([{ h: 30 }], nice)).toEqual({ ymax: 36, cap: 36, over: 0 })
  })
  it('PR дольше 36 ч (CI #456, 170 ч) — шкала 36 и счёт выбросов, остальные точки не сжимаются', () => {
    expect(r.prCap([{ h: 2 }, { h: 170 }, { h: 36 }], nice)).toEqual({ ymax: 36, cap: 36, over: 1 })
  })
})

describe('разбивка по продуктам', () => {
  const { r } = load()
  it('пустой продукт — hr-helper, как в подмене базы', () => {
    const rows = [{ p: 'taibe' }, { p: '' }, { p: undefined }, { p: 'taibe' }]
    expect(r.splitByProduct(rows, (x) => x.p)).toEqual({ taibe: 2, 'hr-helper': 2 })
  })
})
