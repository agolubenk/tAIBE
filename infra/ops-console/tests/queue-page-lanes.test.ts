/**
 * Группировка «Хода работ» на /queue (LANES_JS, page-lanes.ts): дорожки по проектам и секторам t-boards и список выбора
 * в заголовке раздела. Скрипт — строка, исполняется в vm с минимальной подделкой DOM: ровно те методы, которые он зовёт.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { LANES_JS } from '../server/queue/page-lanes'

class El {
  children: El[] = []
  parent: El | null = null
  listeners: Record<string, Array<() => void>> = {}
  attrs: Record<string, string> = {}
  className = ''
  textContent = ''
  value = ''
  disabled = false
  constructor(public tag = 'div') {}
  get options(): El[] {
    return this.children
  }
  get nextSibling(): El | null {
    const sib = this.parent?.children ?? []
    return sib[sib.indexOf(this) + 1] ?? null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  appendChild(node: El): El {
    return this.insertBefore(node, null)
  }
  insertBefore(node: El, ref: El | null): El {
    node.parent = this
    const at = ref ? this.children.indexOf(ref) : -1
    if (at < 0) this.children.push(node)
    else this.children.splice(at, 0, node)
    if (this.tag === 'select' && !this.value) this.value = node.value
    return node
  }
  addEventListener(ev: string, fn: () => void): void {
    ;(this.listeners[ev] ??= []).push(fn)
  }
  fire(ev: string): void {
    this.listeners[ev]?.forEach((fn) => fn())
  }
  querySelector(sel: string): El | null {
    for (const c of this.children) {
      if (sel === c.tag || (sel.startsWith('.') && c.className.split(' ').includes(sel.slice(1)))) return c
      const deep = c.querySelector(sel)
      if (deep) return deep
    }
    return null
  }
}

type Row = { id: string; track: string; cards?: unknown[]; planEnd?: string; basePlanEnd?: string }
type Ctx = { products?: Record<string, string>; trackName?: (id: string) => string; today?: string }
type Tally = { id: string; name: string; c: { closed: number; review: number; open: number }; total: number; due: number }
type Lanes = {
  lanesOf: (rows: Row[], how: string, boards: Record<string, unknown>, ctx?: Ctx) => { tracks: Array<{ id: string; name: string; c: string }>; rows: Array<Row & { trackOf: string }> } | null
  cardsBy: (rows: Row[], how: string, boards: Record<string, unknown>, ctx?: Ctx) => Array<Tally & { groups: Tally[] }>
  slicesOf: (rows: Row[], boards: Record<string, unknown>, ctx?: Ctx) => Array<{ how: string; name: string; items: Array<{ id: string; name: string; n: number }> }>
  mode: () => string
  onChange: (cb: () => void) => void
  apply: (rows: Row[]) => ReturnType<Lanes['lanesOf']>
  cards: (id: string, rows: Row[], today: string, trackName?: (id: string) => string) => { how: string; products: Array<Tally & { groups: Tally[] }> }
  sliceRows: (rows: Row[], trackName?: (id: string) => string) => { rows: Row[]; name: string }
}

const TB = 'aiboards-eval'
const BOARDS = {
  [TB]: {
    kind: 'boards', ws: TB, at: '2026-11-10T20:00:00Z',
    projects: [{ slug: 'OPS', name: 'Инфраструктура' }, { slug: 'TB', name: 't-boards' }],
    sectors: [{ id: 's1', name: 'Очередь владельца', keys: ['OPS-2'] }, { id: 's2', name: 'Доски', keys: ['TB-5', 'OPS-1'] }],
  },
}
const ROWS: Row[] = [
  { id: 'a', track: 't1', cards: [{ key: 'OPS-1', ws: TB }, { key: 'OPS-2', ws: TB }, { key: 'TB-1', ws: TB }] },
  { id: 'b', track: 't1' },
  { id: 'c', track: 't2', cards: [{ key: 'TB-5', ws: TB }, { key: 'OPS-9', ws: TB }] },
  { id: 'd', track: 't2', cards: [{ id: 'notion32hex' }] },
  { id: 'e', track: 't3', cards: [{ key: 'APP-3', ws: 'hr-helper-lavaeon' }] },
]

const PICK_OPTS = ['project', 'sector', 'track', 'product']
function mount(opts: { saved?: string; docs?: unknown[]; store?: Record<string, string> } = {}) {
  const store: Record<string, string> = { ...(opts.saved ? { 'oq-lanes': opts.saved } : {}), ...opts.store }
  // Списки разреза у карточек графиков — как в page.html: #pick-status и #pick-cards с вариантами, #pick-plan пустой.
  const picks: Record<string, El> = {}
  for (const id of ['pick-status', 'pick-cards', 'pick-plan']) {
    const el = (picks[id] = new El('select'))
    for (const v of id === 'pick-plan' ? [''] : PICK_OPTS) {
      const o = new El('option')
      o.value = v
      el.appendChild(o)
    }
  }
  const head = new El('div')
  head.className = 'sec-head'
  head.appendChild(new El('h2'))
  head.appendChild(new El('span'))
  const document = {
    head: new El('head'),
    createElement: (tag: string) => new El(tag),
    querySelector: (sel: string) => (sel === '#agents .sec-head' ? head : picks[sel.slice(1)] ?? null),
  }
  const window = { __oqDocs: (col: string) => (col === 'work' ? opts.docs ?? [] : []) } as { __oqDocs: (c: string) => unknown[]; __oqLanes?: Lanes }
  runInNewContext(LANES_JS, {
    window,
    document,
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } },
  })
  const sel = head.querySelector('.oq-lanes')
  return { lanes: window.__oqLanes!, head, sel, store, picks }
}

describe('группировка «Хода работ» по проектам и секторам t-boards', () => {
  it('проект — большинство карточек строки, при равенстве — первая; имя — из карты доски; без карточек — последней', () => {
    const r = mount().lanes.lanesOf(ROWS, 'project', BOARDS)!
    expect(r.tracks.map((t) => [t.id, t.name])).toEqual([
      [`${TB}/OPS`, 'OPS · Инфраструктура'],
      [`${TB}/TB`, 'TB · t-boards'],
      ['hr-helper-lavaeon/APP', 'APP'],
      ['~', 'Без карточек t-boards'],
    ])
    expect(r.tracks.map((t) => t.c)).toEqual(['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--st-none)'])
    expect(r.rows.map((w) => [w.id, w.track, w.trackOf])).toEqual([
      ['a', `${TB}/OPS`, 't1'], ['c', `${TB}/TB`, 't2'], ['e', 'hr-helper-lavaeon/APP', 't3'], ['b', '~', 't1'], ['d', '~', 't2'],
    ])
    // Строки — копии: данные страницы не меняются.
    expect(ROWS[0]!.track).toBe('t1')
  })

  it('сектор — первый по карте доски, в дерево которого входит карточка строки; вне секторов — последней', () => {
    const r = mount().lanes.lanesOf(ROWS, 'sector', BOARDS)!
    expect(r.tracks.map((t) => [t.id, t.name])).toEqual([[`${TB}#s1`, 'Очередь владельца'], [`${TB}#s2`, 'Доски'], ['~', 'Вне секторов']])
    expect(r.rows.map((w) => [w.id, w.track])).toEqual([['a', `${TB}#s1`], ['c', `${TB}#s2`], ['b', '~'], ['d', '~'], ['e', '~']])
  })

  it('направления и секторы без карты — null: страница рисует направления', () => {
    const { lanes } = mount()
    expect(lanes.lanesOf(ROWS, 'track', BOARDS)).toBeNull()
    expect(lanes.lanesOf(ROWS, 'sector', {})).toBeNull()
    expect(lanes.lanesOf(ROWS, 'sector', { [TB]: { projects: [], sectors: [] } })).toBeNull()
  })

  it('список — после заголовка раздела; выбор сохраняется и перерисовывает; карта — из полного снимка work', () => {
    const old = { ...BOARDS[TB], at: '2026-11-01T00:00:00Z', sectors: [{ id: 'old', name: 'старая', keys: ['TB-5'] }] }
    const p = mount({ docs: [{ id: `boards-${TB}`, data: old }, { id: 'x', data: BOARDS[TB] }, { id: 'w', data: { title: 'строка' } }] })
    expect(p.head.children.map((c) => c.tag)).toEqual(['h2', 'select', 'span'])
    expect(p.sel!.attrs['aria-label']).toBe('Группировать «Ход работ»')
    expect(p.lanes.apply(ROWS)).toBeNull()
    const change = vi.fn()
    p.lanes.onChange(change)
    p.sel!.value = 'sector'
    p.sel!.fire('change')
    expect(change).toHaveBeenCalledTimes(1)
    expect(p.store['oq-lanes']).toBe('sector')
    expect(p.lanes.apply(ROWS)!.tracks[0]!.name).toBe('Очередь владельца')
  })

  it('карты ещё нет — секторы недоступны, сохранённый выбор секторов — направления', () => {
    const p = mount({ saved: 'sector' })
    expect(p.lanes.apply(ROWS)).toBeNull()
    expect(p.sel!.options[2]!.disabled).toBe(true)
    expect(p.sel!.options[2]!.textContent).toBe('Секторы t-boards — карты ещё нет')
    expect(p.sel!.value).toBe('track')
    expect(mount({ saved: '<x>' }).lanes.mode()).toBe('track')
  })
})

// Карточки с планом: OPS-1 — у двух строк (одна карточка, план — по любой из них), APP-4 — прежний трекер (archived).
const CROWS: Row[] = [
  { id: 'a', track: 't1', planEnd: '2026-11-20', basePlanEnd: '2026-11-05', cards: [{ key: 'OPS-1', ws: TB, closed: true }, { key: 'OPS-2', ws: TB, review: true }, { key: 'TB-1', ws: TB }] },
  { id: 'c', track: 't2', planEnd: '2026-11-20', cards: [{ key: 'TB-5', ws: TB, closed: true }, { key: 'OPS-1', ws: TB, closed: true }] },
  { id: 'e', track: 't3', planEnd: '2026-11-01', cards: [{ key: 'APP-3', ws: 'hr-helper-lavaeon' }, { key: 'APP-4', ws: 'hr-helper-lavaeon', archived: true }] },
]
const TODAY = '2026-11-11'
const brief = (t: Tally) => [t.id, t.name, t.c.closed, t.c.review, t.c.open, t.total, t.due]

describe('разрезы по продуктам (просьба владельца 11.11)', () => {
  it('«Продукты» — четвёртый вариант общего списка; продукт строки — по доскам карточек, без карточек — hr-helper', () => {
    const p = mount()
    expect(p.sel!.options.map((o) => [o.value, o.textContent])).toEqual([
      ['track', 'Блоки (направления)'], ['project', 'Проекты t-boards'], ['sector', 'Секторы t-boards — карты ещё нет'], ['product', 'Продукты'],
    ])
    const r = p.lanes.lanesOf(ROWS, 'product', BOARDS)!
    expect(r.tracks.map((t) => t.id)).toEqual(['taibe', 'hr-helper'])
    expect(r.rows.map((w) => [w.id, w.track, w.trackOf])).toEqual([
      ['a', 'taibe', 't1'], ['c', 'taibe', 't2'], ['b', 'hr-helper', 't1'], ['d', 'hr-helper', 't2'], ['e', 'hr-helper', 't3'],
    ])
    // Подмена базы (полный снимок work) важнее досок карточек.
    expect(p.lanes.lanesOf(ROWS, 'product', BOARDS, { products: { b: 'taibe' } })!.rows.find((w) => w.id === 'b')!.track).toBe('taibe')
  })

  it('карточки по продуктам и проектам: одна на ws/ключ, archived не в счёт, план — по исходному сроку строки', () => {
    const out = mount().lanes.cardsBy(CROWS, 'project', BOARDS, { today: TODAY })
    expect(out.map(brief)).toEqual([['taibe', 'taibe', 2, 1, 1, 4, 3], ['hr-helper', 'hr-helper', 0, 0, 1, 1, 1]])
    expect(out[0]!.groups.map(brief)).toEqual([
      [`${TB}/OPS`, 'OPS · Инфраструктура', 1, 1, 0, 2, 2],
      [`${TB}/TB`, 'TB · t-boards', 1, 0, 1, 2, 1],
    ])
    expect(out[1]!.groups.map(brief)).toEqual([['hr-helper-lavaeon/APP', 'APP', 0, 0, 1, 1, 1]])
  })

  it('внутри продукта — секторы (вне секторов — последним), блоки или ничего', () => {
    const { lanes } = mount()
    expect(lanes.cardsBy(CROWS, 'sector', BOARDS, { today: TODAY })[0]!.groups.map((g) => [g.name, g.total])).toEqual([
      ['Доски', 2], ['Очередь владельца', 1], ['Вне секторов', 1],
    ])
    const tr = lanes.cardsBy(CROWS, 'track', BOARDS, { today: TODAY, trackName: (id) => 'Блок ' + id })
    expect(tr[0]!.groups.map((g) => [g.name, g.total])).toEqual([['Блок t1', 3], ['Блок t2', 1]])
    expect(lanes.cardsBy(CROWS, 'product', BOARDS, { today: TODAY }).map((p) => p.groups)).toEqual([[], []])
  })

  it('варианты среза «план и факт» — продукты, проекты, секторы (с картой), блоки; число задач у каждого', () => {
    const { lanes } = mount()
    const sl = lanes.slicesOf(ROWS, BOARDS, { trackName: (id) => 'Блок ' + id })
    expect(sl.map((s) => s.how)).toEqual(['product', 'project', 'sector', 'track'])
    expect(sl[0]!.items.map((x) => [x.id, x.n])).toEqual([['hr-helper', 3], ['taibe', 2]])
    expect(sl[3]!.items.map((x) => [x.name, x.n])).toEqual([['Блок t1', 2], ['Блок t2', 2], ['Блок t3', 1]])
    expect(lanes.slicesOf(ROWS, {}).map((s) => s.how)).toEqual(['product', 'project', 'track'])
  })

  it('срез из сохранённого выбора: строки одного продукта и его имя; неизвестный срез — все задачи', () => {
    const one = mount({ store: { 'oq-pick-plan': 'product:taibe' } })
    expect(one.lanes.sliceRows(ROWS)).toEqual({ rows: [ROWS[0], ROWS[2]], name: 'taibe' })
    expect(one.picks['pick-plan']!.value).toBe('product:taibe')
    const gone = mount({ store: { 'oq-pick-plan': 'product:нет-такого' } })
    expect(gone.lanes.sliceRows(ROWS)).toEqual({ rows: ROWS, name: '' })
  })

  it('разрез карточек — из своего списка и запоминается; секторы без карты — проекты', () => {
    const docs = [{ id: `boards-${TB}`, data: BOARDS[TB] }]
    const p = mount({ docs, store: { 'oq-pick-status': 'sector' } })
    expect(p.lanes.cards('pick-status', CROWS, TODAY).how).toBe('sector')
    expect(p.lanes.cards('pick-cards', CROWS, TODAY).how).toBe('project')
    p.picks['pick-cards']!.value = 'product'
    p.picks['pick-cards']!.fire('change')
    expect(p.store['oq-pick-cards']).toBe('product')
    expect(p.lanes.cards('pick-cards', CROWS, TODAY).products.map((x) => x.groups.length)).toEqual([0, 0])
    const noMap = mount({ store: { 'oq-pick-status': 'sector' } })
    expect(noMap.lanes.cards('pick-status', CROWS, TODAY).how).toBe('project')
    expect(noMap.picks['pick-status']!.options[1]!.disabled).toBe(true)
  })
})
