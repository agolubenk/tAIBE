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

type Row = { id: string; track: string; cards?: unknown[] }
type Lanes = {
  lanesOf: (rows: Row[], how: string, boards: Record<string, unknown>) => { tracks: Array<{ id: string; name: string; c: string }>; rows: Array<Row & { trackOf: string }> } | null
  mode: () => string
  onChange: (cb: () => void) => void
  apply: (rows: Row[]) => ReturnType<Lanes['lanesOf']>
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

function mount(opts: { saved?: string; docs?: unknown[] } = {}) {
  const store: Record<string, string> = opts.saved ? { 'oq-lanes': opts.saved } : {}
  const head = new El('div')
  head.className = 'sec-head'
  head.appendChild(new El('h2'))
  head.appendChild(new El('span'))
  const document = {
    head: new El('head'),
    createElement: (tag: string) => new El(tag),
    querySelector: (sel: string) => (sel === '#agents .sec-head' ? head : null),
  }
  const window = { __oqDocs: (col: string) => (col === 'work' ? opts.docs ?? [] : []) } as { __oqDocs: (c: string) => unknown[]; __oqLanes?: Lanes }
  runInNewContext(LANES_JS, {
    window,
    document,
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } },
  })
  const sel = head.querySelector('.oq-lanes')
  return { lanes: window.__oqLanes!, head, sel, store }
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
