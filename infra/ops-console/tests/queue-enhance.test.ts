/**
 * Кнопка «Влить» на странице /queue (ENHANCE_JS): без головы, одобренной «Контролем», неактивна; экран
 * подтверждения отказывает при чужой голове и предупреждает о базе не main. Скрипт страницы — строка, поэтому он
 * исполняется в vm с минимальной подделкой DOM: ровно те методы, которые он вызывает.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ENHANCE_JS } from '../server/queue/page-scripts'

class FakeEl {
  dataset: Record<string, string> = {}
  children: FakeEl[] = []
  /** Записи textContent и title: каждая — мутация, на которую просыпается MutationObserver страницы. */
  static writes = 0
  #text = ''
  #title = ''
  get textContent(): string {
    return this.#text
  }
  set textContent(v: string) {
    FakeEl.writes++
    this.#text = v
  }
  get title(): string {
    return this.#title
  }
  set title(v: string) {
    FakeEl.writes++
    this.#title = v
  }
  disabled = false
  type = ''
  listeners: Record<string, Array<() => void>> = {}
  classList = { toggle: (_c: string, _on?: boolean) => {} }
  constructor(public className = '') {}
  querySelector(sel: string): FakeEl | null {
    const cls = sel.replace(/^\./, '')
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) return c
      const deep = c.querySelector(sel)
      if (deep) return deep
    }
    return null
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null
  }
  insertBefore(node: FakeEl): void {
    this.children.unshift(node)
  }
  appendChild(node: FakeEl): void {
    this.children.push(node)
  }
  addEventListener(ev: string, fn: () => void): void {
    ;(this.listeners[ev] ??= []).push(fn)
  }
  click(): void {
    this.listeners.click?.forEach((fn) => fn())
  }
}

const SHA = 'a'.repeat(40)

function mountPage(docs: Array<{ id: string; data: Record<string, unknown> }>, info: Record<string, unknown>) {
  const items = ['m-1', 'm-2'].map((id) => {
    const el = new FakeEl('item')
    el.dataset.id = id
    const answer = new FakeEl('answer')
    answer.appendChild(new FakeEl('saved'))
    el.appendChild(answer)
    return el
  })
  const head = new FakeEl('sec-head')
  let onMutation: () => void = () => {}
  const calls: Array<{ method: string; path: string }> = []
  const confirm = vi.fn(() => false)
  const sandbox = {
    window: { __oqDocs: (col: string) => (col === 'items' ? docs : []), confirm, alert: vi.fn() },
    document: {
      body: {},
      querySelectorAll: (sel: string) => (sel.startsWith('#sec-merge .item') ? items : []),
      querySelector: (sel: string) => (sel === '#sec-merge .sec-head' ? head : null),
      createElement: () => new FakeEl(),
    },
    fetch: (url: string, init: { method: string }) => {
      calls.push({ method: init.method, path: url })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(info) })
    },
    MutationObserver: class {
      constructor(cb: () => void) {
        onMutation = cb
      }
      observe() {}
    },
    requestAnimationFrame: (cb: () => void) => cb(),
  }
  runInNewContext(ENHANCE_JS, sandbox)
  const button = (id: string) => items.find((i) => i.dataset.id === id)!.querySelector('.oq-merge')!
  const saved = (id: string) => items.find((i) => i.dataset.id === id)!.querySelector('.saved')!.textContent
  return { button, saved, calls, confirm, mutate: () => onMutation() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const info = (over: Record<string, unknown>) => ({
  pr: 162,
  title: 'PR',
  state: 'open',
  headSha: SHA,
  headRef: 'fix/x',
  baseRef: 'main',
  skipCi: false,
  deploys: true,
  deployRunning: false,
  mergeable: true,
  approval: 'ok',
  approvedSha: SHA,
  approvedBase: 'main',
  ...over,
})

describe('кнопка «Влить» на странице очереди', () => {
  it('повторный проход без изменений ничего не пишет — наблюдатель не будит себя каждый кадр', () => {
    const page = mountPage([{ id: 'm-1', data: { kind: 'merge', pr: 1 } }], info({}))
    const before = FakeEl.writes
    page.mutate()
    page.mutate()
    expect(FakeEl.writes).toBe(before)
  })

  it('без головы, одобренной «Контролем», — неактивна; появилось поле sha — активна', () => {
    const docs = [
      { id: 'm-1', data: { kind: 'merge', pr: 1 } },
      { id: 'm-2', data: { kind: 'merge', pr: 2, sha: SHA, base: 'main' } },
    ]
    const page = mountPage(docs, info({}))
    expect(page.button('m-1')).toMatchObject({ disabled: true, textContent: 'Ждёт вердикта «Контроля»' })
    expect(page.button('m-2')).toMatchObject({ disabled: false, textContent: 'Влить сейчас…' })
    docs[0]!.data.sha = 'b'.repeat(40)
    page.mutate()
    // Голова без базы — вердикт неполный, кнопка всё ещё неактивна.
    expect(page.button('m-1').disabled).toBe(true)
    docs[0]!.data.base = 'main'
    page.mutate()
    expect(page.button('m-1')).toMatchObject({ disabled: false, textContent: 'Влить сейчас…' })
  })

  it('короткий SHA в пункте — не одобрение', () => {
    const page = mountPage([{ id: 'm-1', data: { kind: 'merge', pr: 1, sha: 'aaaaaaa', base: 'main' } }], info({}))
    expect(page.button('m-1').disabled).toBe(true)
  })

  it('голова PR сменилась после вердикта — отказ на экране, без подтверждения и без мёржа', async () => {
    const page = mountPage([{ id: 'm-2', data: { kind: 'merge', pr: 2, sha: SHA, base: 'main' } }], info({ approval: 'mismatch', approvedSha: 'd'.repeat(40) }))
    page.button('m-2').click()
    await flush()
    await flush()
    expect(page.saved('m-2')).toContain('нужен новый вердикт')
    expect(page.confirm).not.toHaveBeenCalled()
    expect(page.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('база PR сменилась после вердикта — отказ на экране, без подтверждения', async () => {
    const page = mountPage([{ id: 'm-2', data: { kind: 'merge', pr: 2, sha: SHA, base: 'main' } }], info({ approval: 'base', approvedBase: 'review/ai-bundle' }))
    page.button('m-2').click()
    await flush()
    await flush()
    expect(page.saved('m-2')).toContain('для базы «review/ai-bundle»')
    expect(page.confirm).not.toHaveBeenCalled()
  })

  it('база не main — предупреждение в подтверждении; отказ владельца — мёржа нет', async () => {
    const page = mountPage([{ id: 'm-2', data: { kind: 'merge', pr: 2, sha: SHA, base: 'main' } }], info({ baseRef: 'review/ai-bundle' }))
    page.button('m-2').click()
    await flush()
    await flush()
    expect(page.confirm).toHaveBeenCalledTimes(1)
    const text = String((page.confirm.mock.calls[0] as unknown[])[0])
    expect(text).toContain('не main')
    expect(text).toContain('review/ai-bundle')
    expect(page.calls.map((c) => c.method)).toEqual(['GET'])
  })
})
