/**
 * Продукт на странице /queue: выбор продукта первым в шапке страницы (PRODUCTS_JS + отбор снимков в подмене базы
 * SHIM_JS), подпись с выбором у переносимых пунктов, смена с подтверждением и возвратом. Скрипты — строки, исполняются в
 * vm с минимальной подделкой DOM: ровно те методы, которые они вызывают (как tests/queue-enhance.test.ts).
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PRODUCTS_JS } from '../server/queue/page-products'
import { SHIM_JS } from '../server/queue/page-scripts'

class FakeEl {
  dataset: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  listeners: Record<string, Array<() => void>> = {}
  attrs: Record<string, string> = {}
  classes = new Set<string>()
  value = ''
  selected = false
  disabled = false
  hidden = false
  #text = ''
  classList = {
    toggle: (c: string, on?: boolean) => (on ?? !this.classes.has(c) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  }
  constructor(public tag = 'div', public className = '') {}
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    this.#text = v
    this.children = []
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  appendChild(node: FakeEl): FakeEl {
    node.parent = this
    this.children.push(node)
    if (this.tag === 'select' && node.selected) this.value = node.value
    if (this.tag === 'select' && this.children.length === 1 && !this.value) this.value = node.value
    return node
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parent = this
    const at = ref ? this.children.indexOf(ref) : -1
    if (at < 0) this.children.push(node)
    else this.children.splice(at, 0, node)
    return node
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  addEventListener(ev: string, fn: () => void): void {
    ;(this.listeners[ev] ??= []).push(fn)
  }
  fire(ev: string): void {
    this.listeners[ev]?.forEach((fn) => fn())
  }
  querySelector(sel: string): FakeEl | null {
    const want = sel.replace(/^\./, '')
    for (const c of this.children) {
      if (c.className.split(' ').includes(want) || c.tag === want) return c
      const deep = c.querySelector(sel)
      if (deep) return deep
    }
    return null
  }
}

const PRODUCTS = [
  { slug: 'hr-helper', name: 'Lavaeon (HR Helper)' },
  { slug: 'taibe', name: 'tAIBE' },
]
const decision = { kind: 'decision', title: 'x' }

type PageOpts = {
  filter?: string
  confirm?: boolean
  post?: { status: number; body: unknown }
  products?: unknown[]
  productsFail?: boolean
  oneProduct?: boolean
}

function mountPage(opts: PageOpts = {}) {
  const item = (id: string, src: string | null) => {
    const el = new FakeEl('article', 'item')
    el.dataset.id = id
    if (src) el.dataset.src = src
    el.appendChild(new FakeEl('div', 'item-head'))
    el.appendChild(new FakeEl('span', 'saved'))
    return el
  }
  const items = [item('d-1', 'db'), item('taibe-d-2', 'db'), item('d-static', null), item('i-1', 'db'), item('m-ok', 'db')]
  // Шапка страницы: первой — кнопка «Поставить задачу», выбор продукта встаёт перед ней.
  const headBar = new FakeEl('div', 'head-bar')
  headBar.appendChild(new FakeEl('button', 'hb-btn hb-compose'))
  const store: Record<string, string> = opts.filter ? { 'oq-product-filter': opts.filter } : {}
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const refresh = vi.fn()
  let onSnapshot: () => void = () => {}
  const document = {
    head: new FakeEl('head'),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => Object.assign(new FakeEl('#text'), { textContent: t }),
    getElementById: (id: string) => (id === 'head-bar' ? headBar : null),
    querySelectorAll: () => items,
  }
  const docs = [
    { id: 'd-1', data: decision, version: 1, product: 'hr-helper' },
    { id: 'taibe-d-2', data: decision, version: 1, product: opts.oneProduct ? 'hr-helper' : 'taibe' },
    { id: 'i-1', data: { kind: 'inbox', title: 'входящее' }, version: 1, product: 'hr-helper' },
    { id: 'm-ok', data: { kind: 'merge', title: 'мёрж', sha: 'a'.repeat(40), base: 'main' }, version: 1, product: 'hr-helper' },
  ]
  // Подмена базы (SHIM_JS) берёт сохранённый выбор при загрузке страницы — до ответа /products.
  let view = opts.filter ?? ''
  const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  const window = {
    confirm: vi.fn((_text: string) => opts.confirm ?? true),
    __oqDocs: () => docs,
    __oqRefresh: refresh,
    __oqView: vi.fn((slug: string) => { view = slug }),
    __oqViewOf: () => view,
    __oqKeep: vi.fn(),
    claude: { use: () => Promise.resolve({ collection: () => ({ onSnapshot: (fn: () => void) => { onSnapshot = fn } }) }) },
  }
  const ctx = {
    window,
    document,
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } },
    fetch: (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
      if (path === '/api/oq/v1/products') {
        return opts.productsFail ? Promise.reject(new Error('offline')) : respond(200, { products: opts.products ?? PRODUCTS })
      }
      return respond(opts.post?.status ?? 200, opts.post?.body ?? { changed: true })
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn: () => void) => fn(),
  }
  runInNewContext(PRODUCTS_JS, ctx)
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }
  const box = (el: FakeEl) => el.querySelector('item-head')!.querySelector('item-product')
  const select = (el: FakeEl) => box(el)!.querySelector('select')!
  const picker = () => headBar.querySelector('oq-product-pick')
  const off = () => items.map((el) => el.classes.has('oq-off'))
  return { items, headBar, store, calls, refresh, window, flush, box, select, picker, off, view: () => view, snapshot: () => onSnapshot(), docs }
}

describe('продукт пункта на странице', () => {
  it('подпись «Продукт:» с выбором — только у переносимых пунктов из базы', async () => {
    const p = mountPage()
    await p.flush()
    expect(p.select(p.items[0]!).value).toBe('hr-helper')
    expect(p.select(p.items[1]!).value).toBe('taibe')
    expect(p.box(p.items[0]!)!.children[0]!.textContent).toBe('Продукт:')
    expect(p.select(p.items[0]!).children.map((o) => o.textContent)).toEqual(['Lavaeon (HR Helper)', 'tAIBE'])
    // Вшитый в страницу пункт и мёрж с вердиктом «Контроля» не переносятся — выбора нет; входящее — переносится.
    expect([2, 4].map((i) => p.box(p.items[i]!))).toEqual([null, null])
    expect(p.select(p.items[3]!).value).toBe('hr-helper')
    // Строка автопередачи страницы берёт продукт отсюда: автопередача — только HR.
    const productOf = (p.window as unknown as { __oqProductOf: (id: string) => string }).__oqProductOf
    expect(productOf('taibe-d-2')).toBe('taibe')
    expect(productOf('i-1')).toBe('hr-helper')
  })

  it('входящее — с предупреждением владельца «задачу никто не возьмёт» (решение now-warn)', async () => {
    const p = mountPage()
    await p.flush()
    const sel = p.select(p.items[3]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    expect(String(p.window.confirm.mock.calls[0]?.[0])).toMatch(/Сессий «tAIBE» пока нет, задачу никто не возьмёт/)
    expect(p.calls.at(-1)).toEqual({ path: '/api/oq/v1/items/i-1/product', method: 'POST', body: { to: 'taibe' } })
  })

  it('смена — с подтверждением (о сессиях другого продукта), запросом владельца и перечиткой items и checks', async () => {
    const p = mountPage()
    await p.flush()
    const sel = p.select(p.items[0]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    expect(String(p.window.confirm.mock.calls[0]?.[0])).toMatch(/Сессий «tAIBE» в очереди пока нет/)
    expect(p.calls.at(-1)).toEqual({ path: '/api/oq/v1/items/d-1/product', method: 'POST', body: { to: 'taibe' } })
    expect(p.refresh.mock.calls.map((c) => c[0])).toEqual(['items', 'checks'])
    expect(p.items[0]!.querySelector('saved')!.textContent).toBe('✓ Продукт: tAIBE')
  })

  it('вернуть прежний продукт можно сразу, до нового снимка', async () => {
    const p = mountPage()
    await p.flush()
    const sel = p.select(p.items[0]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    sel.value = 'hr-helper'
    sel.fire('change')
    await p.flush()
    expect(p.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ to: 'taibe' }, { to: 'hr-helper' }])
    expect(String(p.window.confirm.mock.calls[1]?.[0])).toMatch(/Сессии «tAIBE» его больше не увидят/)
  })

  it('отмена — без запроса, выбор возвращается; ошибка сервера — выбор возвращается, текст ошибки у пункта', async () => {
    const no = mountPage({ confirm: false })
    await no.flush()
    const s1 = no.select(no.items[0]!)
    s1.value = 'taibe'
    s1.fire('change')
    await no.flush()
    expect(no.calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(s1.value).toBe('hr-helper')

    const bad = mountPage({ post: { status: 409, body: { error: 'Нельзя' } } })
    await bad.flush()
    const s2 = bad.select(bad.items[0]!)
    s2.value = 'taibe'
    s2.fire('change')
    await bad.flush()
    expect(s2.value).toBe('hr-helper')
    expect(bad.items[0]!.querySelector('saved')!.textContent).toBe('Нельзя')
  })

  it('продукт пункта сменился в снимке — подпись обновляется по подписке на снимок, без таймера', async () => {
    const p = mountPage()
    await p.flush()
    p.docs[0]!.product = 'taibe'
    p.snapshot()
    expect(p.select(p.items[0]!).value).toBe('taibe')
  })
})

describe('выбор продукта вверху страницы', () => {
  it('первым в шапке: «Все продукты» и продукты актора; сохранённый выбор — сразу, без повторной выдачи снимков', async () => {
    const p = mountPage({ filter: 'taibe' })
    p.items[3]!.classes.add('is-target')
    await p.flush()
    const pick = p.picker()!
    expect(p.headBar.children[0]).toBe(pick)
    expect(pick.tag).toBe('select')
    expect(pick.attrs['aria-label']).toMatch(/Продукт/)
    expect(pick.children.map((o) => o.textContent)).toEqual(['Все продукты', 'Lavaeon (HR Helper)', 'tAIBE'])
    expect(pick.value).toBe('taibe')
    // Подмена базы уже отбирает по сохранённому выбору — страница не получает снимки второй раз.
    expect(p.window.__oqView).not.toHaveBeenCalled()
    // Вшитый пункт страницы — HR: при tAIBE спрятан; пункт из «#item=» виден всегда.
    expect(p.off()[2]).toBe(true)
    expect(p.off()[3]).toBe(false)
  })

  it('смена выбора — в браузер и в подмену базы; «Все продукты» стирает сохранённое', async () => {
    const p = mountPage()
    await p.flush()
    expect(p.window.__oqView).not.toHaveBeenCalled()
    const pick = p.picker()!
    pick.value = 'taibe'
    pick.fire('change')
    expect(p.store['oq-product-filter']).toBe('taibe')
    expect(p.view()).toBe('taibe')
    pick.value = ''
    pick.fire('change')
    expect(p.store['oq-product-filter']).toBeUndefined()
    expect(p.window.__oqView.mock.calls.map((c) => c[0])).toEqual(['taibe', ''])
    expect(p.off()).toEqual([false, false, false, false, false])
  })

  it('перенесённый пункт виден при выбранном продукте до смены выбора — подмена базы его не прячет', async () => {
    const p = mountPage({ filter: 'hr-helper' })
    await p.flush()
    const sel = p.select(p.items[0]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    expect(p.window.__oqKeep).toHaveBeenCalledWith('d-1')
    p.docs[0]!.product = 'taibe'
    p.snapshot()
    expect(p.off()[0]).toBe(false)
  })

  it('сохранён продукт, которого нет (lavaeon до слияния), — выбор стёрт, отбора нет', async () => {
    const p = mountPage({ filter: 'lavaeon' })
    await p.flush()
    expect(p.store['oq-product-filter']).toBeUndefined()
    expect(p.window.__oqView).toHaveBeenCalledWith('')
    expect(p.picker()!.value).toBe('')
    expect(p.off().some(Boolean)).toBe(false)
  })

  it('актору виден один продукт — выбора нет, отбора нет', async () => {
    const p = mountPage({ filter: 'hr-helper', products: [PRODUCTS[0]] })
    await p.flush()
    expect(p.picker()).toBeNull()
    expect(p.headBar.children).toHaveLength(1)
    expect(p.view()).toBe('')
    expect(p.off().some(Boolean)).toBe(false)
  })

  it('без справочника продуктов или без связи — страница как до v2-lite: ни подписей, ни выбора, ни отбора', async () => {
    for (const opts of [{ products: [] }, { productsFail: true }]) {
      const p = mountPage({ filter: 'taibe', ...opts })
      await p.flush()
      expect(p.items[0]!.querySelector('item-head')!.children).toEqual([])
      expect(p.picker()).toBeNull()
      expect(p.view()).toBe('')
      // Сбой справочника — не повод стирать выбор владельца.
      expect(p.store['oq-product-filter']).toBe('taibe')
    }
  })
})

describe('отбор снимков по продукту в подмене базы (SHIM_JS)', () => {
  const ROWS: Record<string, Array<{ id: string; data: Record<string, unknown>; version: number; product?: string }>> = {
    items: [
      { id: 'd-hr', data: decision, version: 1, product: 'hr-helper' },
      { id: 'taibe-d-1', data: decision, version: 1, product: 'taibe' },
      { id: 'd-old', data: decision, version: 1 },
      { id: 'taibe-d-link', data: decision, version: 1, product: 'taibe' },
    ],
    work: [
      { id: 'w-hr', data: { title: 'HR', track: 'core' }, version: 1, product: 'hr-helper' },
      { id: 'taibe-w-1', data: { title: 'tAIBE', track: 'core' }, version: 1, product: 'taibe' },
      { id: 'track-core', data: { kind: 'track', title: 'Ядро' }, version: 1, product: 'hr-helper' },
    ],
    checks: [
      { id: 'd-hr', data: { done: true }, version: 1, product: 'hr-helper' },
      { id: 'taibe-d-1', data: { done: false }, version: 1, product: 'taibe' },
    ],
  }

  function shim(saved: string | null, hash = '') {
    const store: Record<string, string> = saved === null ? {} : { 'oq-product-filter': saved }
    const listeners: Record<string, Array<() => void>> = {}
    const location = { hash }
    type Win = {
      claude: { use: (cap: string) => Promise<{ collection: (c: string) => { onSnapshot: (ok: (d: Array<{ id: string }>) => void) => void } }> }
      __oqDocs: (col: string) => unknown[]
      __oqView: (slug: string) => void
      __oqViewOf: () => string
      __oqKeep: (id: string) => void
    }
    const win = { addEventListener: (ev: string, fn: () => void) => { ;(listeners[ev] ??= []).push(fn) } } as unknown as Win
    runInNewContext(SHIM_JS, {
      window: win,
      location,
      console,
      setTimeout: () => 0,
      clearTimeout: () => {},
      document: { hidden: false, addEventListener() {} },
      localStorage: { getItem: (k: string) => store[k] ?? null },
      fetch: (url: string) => {
        const col = url.replace('/api/oq/v1/db/', '')
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => '"e1"' }, json: () => Promise.resolve({ docs: ROWS[col] ?? [] }) })
      },
    })
    const got: Record<string, string[][]> = { items: [], work: [], checks: [] }
    const subscribe = async () => {
      const db = await win.claude.use('db')
      for (const col of Object.keys(got)) db.collection(col).onSnapshot((d) => got[col]!.push(d.map((x) => x.id)))
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
    }
    const last = (col: string) => got[col]!.at(-1)
    return { win, location, listeners, got, last, subscribe }
  }

  it('сохранённый выбор действует с первого снимка: пункты и задачи — одного продукта, направления и ответы — все', async () => {
    const s = shim('taibe')
    await s.subscribe()
    expect(s.got.items).toEqual([['taibe-d-1', 'taibe-d-link']])
    expect(s.last('work')).toEqual(['taibe-w-1', 'track-core'])
    expect(s.last('checks')).toEqual(['d-hr', 'taibe-d-1'])
    // Полный снимок — у кнопок мёржа и меток продукта.
    expect(s.win.__oqDocs('items')).toHaveLength(4)
    expect(s.win.__oqViewOf()).toBe('taibe')
  })

  it('без продукта у строки — HR; смена выбора отдаёт снимки заново без запроса; «» — все', async () => {
    const s = shim(null)
    await s.subscribe()
    expect(s.last('items')).toEqual(['d-hr', 'taibe-d-1', 'd-old', 'taibe-d-link'])
    s.win.__oqView('hr-helper')
    expect(s.last('items')).toEqual(['d-hr', 'd-old'])
    expect(s.last('work')).toEqual(['w-hr', 'track-core'])
    s.win.__oqView('')
    expect(s.last('items')).toEqual(['d-hr', 'taibe-d-1', 'd-old', 'taibe-d-link'])
    // Ответы при смене выбора не перевыдаются: их отбор не меняется.
    expect(s.got.checks).toHaveLength(1)
  })

  it('пункт из «#item=<id>» и перенесённый на странице видны при любом выборе', async () => {
    const s = shim('hr-helper', '#item=taibe-d-link')
    await s.subscribe()
    expect(s.last('items')).toEqual(['d-hr', 'd-old', 'taibe-d-link'])
    s.location.hash = '#item=taibe-d-1'
    s.listeners['hashchange']!.forEach((fn) => fn())
    expect(s.last('items')).toEqual(['d-hr', 'taibe-d-1', 'd-old'])
    s.win.__oqKeep('taibe-d-link')
    s.location.hash = ''
    s.listeners['hashchange']!.forEach((fn) => fn())
    expect(s.last('items')).toEqual(['d-hr', 'd-old', 'taibe-d-link'])
    // Смена выбора сбрасывает перенесённые.
    s.win.__oqView('hr-helper')
    expect(s.last('items')).toEqual(['d-hr', 'd-old'])
  })

  it('недопустимое сохранённое значение — без отбора', async () => {
    const bad = shim('<script>')
    await bad.subscribe()
    expect(bad.win.__oqViewOf()).toBe('')
    expect(bad.last('items')).toHaveLength(4)
  })
})
