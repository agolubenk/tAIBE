/**
 * Продукт пункта на странице /queue (PRODUCTS_JS): метка с выбором у каждого пункта, смена продукта владельцем с
 * подтверждением, фильтр «Все / продукт». Скрипт — строка, исполняется в vm с минимальной подделкой DOM: ровно те методы,
 * которые он вызывает (как tests/queue-enhance.test.ts).
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PRODUCTS_JS } from '../server/queue/page-products'

class FakeEl {
  dataset: Record<string, string> = {}
  children: FakeEl[] = []
  listeners: Record<string, Array<() => void>> = {}
  classes = new Set<string>()
  value = ''
  selected = false
  disabled = false
  hidden = false
  attrs: Record<string, string> = {}
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
    this.children.push(node)
    if (this.tag === 'select' && node.selected) this.value = node.value
    if (this.tag === 'select' && this.children.length === 1 && !this.value) this.value = node.value
    return node
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

function mountPage(opts: { filter?: string; confirm?: boolean; post?: { status: number; body: unknown }; products?: unknown[] } = {}) {
  const item = (id: string, src: string | null) => {
    const el = new FakeEl('article', 'item')
    el.dataset.id = id
    if (src) el.dataset.src = src
    el.appendChild(new FakeEl('div', 'item-head'))
    el.appendChild(new FakeEl('span', 'saved'))
    return el
  }
  const items = [item('d-1', 'db'), item('taibe-d-2', 'db'), item('d-static', null)]
  const toolbar = new FakeEl('div', 'toolbar')
  const store: Record<string, string> = opts.filter ? { 'oq-product-filter': opts.filter } : {}
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const refresh = vi.fn()
  let onTick: () => void = () => {}
  const document = {
    head: new FakeEl('head'),
    body: new FakeEl('body'),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => Object.assign(new FakeEl('#text'), { textContent: t }),
    querySelector: (sel: string) => (sel === 'header .toolbar' ? toolbar : sel === '.oq-product-hint' ? toolbar.querySelector('oq-product-hint') : null),
    querySelectorAll: () => items,
  }
  const docs = [
    { id: 'd-1', data: {}, version: 1, product: 'hr-helper' },
    { id: 'taibe-d-2', data: {}, version: 1, product: 'taibe' },
  ]
  const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  const window = {
    confirm: vi.fn(() => opts.confirm ?? true),
    __oqDocs: () => docs,
    __oqRefresh: refresh,
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
    setInterval: (fn: () => void) => { onTick = fn },
  }
  runInNewContext(PRODUCTS_JS, ctx)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const select = (el: FakeEl) => el.querySelector('item-head')!.querySelector('item-product')!.querySelector('select')!
  return { items, toolbar, store, calls, refresh, window, flush, select, tick: () => onTick(), docs }
}

describe('продукт пункта на странице', () => {
  it('у каждого пункта — метка с продуктом; вшитый в страницу пункт — без смены', async () => {
    const p = mountPage()
    await p.flush()
    expect(p.select(p.items[0]!).value).toBe('hr-helper')
    expect(p.select(p.items[1]!).value).toBe('taibe')
    expect(p.select(p.items[0]!).children.map((o) => o.textContent)).toEqual(['HR Helper', 'Lavaeon', 'aiBoards&eval'])
    expect(p.select(p.items[2]!).disabled).toBe(true)
    expect(p.select(p.items[0]!).disabled).toBe(false)
  })

  it('смена — с подтверждением, запросом владельца и перечиткой items и checks', async () => {
    const p = mountPage()
    await p.flush()
    const sel = p.select(p.items[0]!)
    sel.value = 'taibe'
    sel.fire('change')
    await p.flush()
    await p.flush()
    expect(p.window.confirm).toHaveBeenCalledTimes(1)
    expect(p.calls.at(-1)).toEqual({ path: '/api/oq/v1/items/d-1/product', method: 'POST', body: { to: 'taibe' } })
    expect(p.refresh.mock.calls.map((c) => c[0])).toEqual(['items', 'checks'])
    expect(p.items[0]!.querySelector('saved')!.textContent).toBe('✓ Продукт: aiBoards&eval')
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

    const bad = mountPage({ post: { status: 409, body: { error: 'У пункта мёржа есть вердикт' } } })
    await bad.flush()
    const s2 = bad.select(bad.items[0]!)
    s2.value = 'taibe'
    s2.fire('change')
    await bad.flush()
    await bad.flush()
    expect(s2.value).toBe('hr-helper')
    expect(bad.items[0]!.querySelector('saved')!.textContent).toBe('У пункта мёржа есть вердикт')
  })

  it('фильтр из браузера скрывает пункты других продуктов; «Все» — показывает', async () => {
    const p = mountPage({ filter: 'taibe' })
    await p.flush()
    expect(p.items.map((el) => el.classes.has('oq-off'))).toEqual([true, false, true])
    const bar = p.toolbar.querySelector('oq-product-filter')!.querySelector('select')!
    expect(bar.value).toBe('taibe')
    bar.value = ''
    bar.fire('change')
    expect(p.items.map((el) => el.classes.has('oq-off'))).toEqual([false, false, false])
    expect(p.store['oq-product-filter']).toBeUndefined()
  })

  it('пункт из ссылки «#item=» виден при любом фильтре', async () => {
    const p = mountPage({ filter: 'taibe' })
    p.items[0]!.classes.add('is-target')
    await p.flush()
    expect(p.items.map((el) => el.classes.has('oq-off'))).toEqual([false, false, true])
  })

  it('без справочника продуктов — страница как до v2-lite: ни меток, ни фильтра', async () => {
    const p = mountPage({ products: [] })
    await p.flush()
    expect(p.items[0]!.querySelector('item-head')!.children).toEqual([])
    expect(p.toolbar.children).toEqual([])
  })

  it('продукт пункта сменился в снимке — метка обновляется на следующей сверке', async () => {
    const p = mountPage()
    await p.flush()
    p.docs[0]!.product = 'lavaeon'
    p.tick()
    expect(p.select(p.items[0]!).value).toBe('lavaeon')
  })
})
