/**
 * Продукт пункта на странице /queue (PRODUCTS_JS): подпись с выбором у переносимых пунктов, смена с подтверждением и
 * возвратом, фильтр «Все / продукт», когда продуктов в очереди больше одного. Скрипт — строка, исполняется в vm с
 * минимальной подделкой DOM: ровно те методы, которые он вызывает (как tests/queue-enhance.test.ts).
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PRODUCTS_JS } from '../server/queue/page-products'

class FakeEl {
  dataset: Record<string, string> = {}
  children: FakeEl[] = []
  parent: FakeEl | null = null
  listeners: Record<string, Array<() => void>> = {}
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
  appendChild(node: FakeEl): FakeEl {
    node.parent = this
    this.children.push(node)
    if (this.tag === 'select' && node.selected) this.value = node.value
    if (this.tag === 'select' && this.children.length === 1 && !this.value) this.value = node.value
    return node
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
  { slug: 'hr-helper', name: 'HR Helper' },
  { slug: 'lavaeon', name: 'Lavaeon' },
  { slug: 'taibe', name: 'aiBoards&eval' },
]
const decision = { kind: 'decision', title: 'x' }

function mountPage(opts: { filter?: string; confirm?: boolean; post?: { status: number; body: unknown }; products?: unknown[]; oneProduct?: boolean } = {}) {
  const item = (id: string, src: string | null) => {
    const el = new FakeEl('article', 'item')
    el.dataset.id = id
    if (src) el.dataset.src = src
    el.appendChild(new FakeEl('div', 'item-head'))
    el.appendChild(new FakeEl('span', 'saved'))
    return el
  }
  const items = [item('d-1', 'db'), item('taibe-d-2', 'db'), item('d-static', null), item('i-1', 'db'), item('m-ok', 'db')]
  const toolbar = new FakeEl('div', 'toolbar')
  const store: Record<string, string> = opts.filter ? { 'oq-product-filter': opts.filter } : {}
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const refresh = vi.fn()
  let onSnapshot: () => void = () => {}
  const document = {
    head: new FakeEl('head'),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => Object.assign(new FakeEl('#text'), { textContent: t }),
    querySelector: (sel: string) => (sel === 'header .toolbar' ? toolbar : null),
    querySelectorAll: () => items,
  }
  const docs = [
    { id: 'd-1', data: decision, version: 1, product: 'hr-helper' },
    { id: 'taibe-d-2', data: decision, version: 1, product: opts.oneProduct ? 'hr-helper' : 'taibe' },
    { id: 'i-1', data: { kind: 'inbox', title: 'входящее' }, version: 1, product: 'hr-helper' },
    { id: 'm-ok', data: { kind: 'merge', title: 'мёрж', sha: 'a'.repeat(40), base: 'main' }, version: 1, product: 'hr-helper' },
  ]
  const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  const window = {
    confirm: vi.fn((_text: string) => opts.confirm ?? true),
    __oqDocs: () => docs,
    __oqRefresh: refresh,
    claude: { use: () => Promise.resolve({ collection: () => ({ onSnapshot: (fn: () => void) => { onSnapshot = fn } }) }) },
  }
  const ctx = {
    window,
    document,
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } },
    fetch: (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
      if (path === '/api/oq/v1/products') return respond(200, { products: opts.products ?? PRODUCTS })
      return respond(opts.post?.status ?? 200, opts.post?.body ?? { changed: true })
    },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (fn: () => void) => fn(),
  }
  runInNewContext(PRODUCTS_JS, ctx)
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }
  const box = (el: FakeEl) => el.querySelector('item-head')!.querySelector('item-product')
  const select = (el: FakeEl) => box(el)!.querySelector('select')!
  const filterSel = () => toolbar.querySelector('oq-product-filter')
  return { items, toolbar, store, calls, refresh, window, flush, box, select, filterSel, snapshot: () => onSnapshot(), docs }
}

describe('продукт пункта на странице', () => {
  it('подпись «Продукт:» с выбором — только у переносимых пунктов из базы', async () => {
    const p = mountPage()
    await p.flush()
    expect(p.select(p.items[0]!).value).toBe('hr-helper')
    expect(p.select(p.items[1]!).value).toBe('taibe')
    expect(p.box(p.items[0]!)!.children[0]!.textContent).toBe('Продукт:')
    expect(p.select(p.items[0]!).children.map((o) => o.textContent)).toEqual(['HR Helper', 'Lavaeon', 'aiBoards&eval'])
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
    expect(String(p.window.confirm.mock.calls[0]?.[0])).toMatch(/Сессий «aiBoards&eval» пока нет, задачу никто не возьмёт/)
    expect(p.calls.at(-1)).toEqual({ path: '/api/oq/v1/items/i-1/product', method: 'POST', body: { to: 'taibe' } })
  })

  it('смена — с подтверждением (о сессиях другого продукта), запросом владельца и перечиткой items и checks', async () => {
    const p = mountPage()
    await p.flush()
    const sel = p.select(p.items[0]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    expect(String(p.window.confirm.mock.calls[0]?.[0])).toMatch(/Сессий «aiBoards&eval» в очереди пока нет/)
    expect(p.calls.at(-1)).toEqual({ path: '/api/oq/v1/items/d-1/product', method: 'POST', body: { to: 'taibe' } })
    expect(p.refresh.mock.calls.map((c) => c[0])).toEqual(['items', 'checks'])
    expect(p.items[0]!.querySelector('saved')!.textContent).toBe('✓ Продукт: aiBoards&eval')
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
    expect(String(p.window.confirm.mock.calls[1]?.[0])).toMatch(/Сессии «aiBoards&eval» его больше не увидят/)
  })

  it('отмена — без запроса, выбор возвращается; ошибка сервера — выбор возвращается, текст ошибки у пункта', async () => {
    const no = mountPage({ confirm: false })
    await no.flush()
    const s1 = no.select(no.items[0]!)
    s1.value = 'lavaeon'
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

  it('фильтр из браузера скрывает пункты других продуктов; «Все» — показывает; пункт из «#item=» виден всегда', async () => {
    const p = mountPage({ filter: 'taibe' })
    p.items[3]!.classes.add('is-target')
    await p.flush()
    expect(p.items.map((el) => el.classes.has('oq-off'))).toEqual([true, false, true, false, true])
    const bar = p.filterSel()!.querySelector('select')!
    expect(bar.value).toBe('taibe')
    bar.value = ''
    bar.fire('change')
    expect(p.items.map((el) => el.classes.has('oq-off'))).toEqual([false, false, false, false, false])
    expect(p.store['oq-product-filter']).toBeUndefined()
  })

  it('один продукт в очереди — фильтра нет, сохранённый выбор не действует', async () => {
    const p = mountPage({ filter: 'taibe', oneProduct: true })
    await p.flush()
    expect(p.filterSel()).toBeNull()
    expect(p.items.some((el) => el.classes.has('oq-off'))).toBe(false)
  })

  it('без справочника продуктов — страница как до v2-lite: ни подписей, ни фильтра', async () => {
    const p = mountPage({ products: [] })
    await p.flush()
    expect(p.items[0]!.querySelector('item-head')!.children).toEqual([])
    expect(p.toolbar.children).toEqual([])
  })

  it('продукт пункта сменился в снимке — подпись обновляется по подписке на снимок, без таймера', async () => {
    const p = mountPage()
    await p.flush()
    p.docs[0]!.product = 'lavaeon'
    p.snapshot()
    expect(p.select(p.items[0]!).value).toBe('lavaeon')
  })
})
