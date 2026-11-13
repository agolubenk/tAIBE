/**
 * «Ход работ» страницы очереди: направления из базы, карточки t-boards в строках плана, сводка сверки.
 * Страница — один HTML с встроенным скриптом, поэтому чистые функции выделены маркерами oq-pure и проверяются
 * здесь отдельно от DOM.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { OPEN_RULE_JS } from '../server/queue/open-rule'
import { PRODUCTS_JS } from '../server/queue/page-products'
import { SHIM_JS } from '../server/queue/page-scripts'

const html = readFileSync(join(__dirname, '../server/queue/page.html'), 'utf8')

type Track = { id: string; name: string; c: string; order: number | null; archived?: boolean }
type Card = { key: string; ws: string; archived: boolean; t: string; k: string; s: string; st: string; c: string; closed: boolean; review: boolean }
type Pure = {
  trackFromDb: (id: string, d: unknown) => Track | null
  mergeTracks: (seed: { id: string; name: string; c: string }[], extra: (Track | null)[]) => Track[]
  cleanCards: (list: unknown) => Card[]
  cardsLabel: (cards: Card[]) => string
  cardRowHtml: (c: Record<string, unknown>) => string
  cardsInPlan: (rows: { who?: string; planEnd?: string; cards?: Card[] }[]) => { dated: number; undated: number; owner: number }
  statsFromDb: (d: unknown) => null | { bugs: Record<string, number>; tasks: Record<string, number>; inPlan: number; notInPlan: number; history: { d: string; bugs: number }[] }
  lagOf: (w: Row, t: Date) => number | null
  lagGroups: (ws: Row[], t: Date) => { open: { w: Row; lag: number }[]; closed: { w: Row; lag: number }[]; onTime: number }
  classifyOwnText: (text: string) => { type: string; urgency: string; severity?: string }
  inboxTitleOf: (text: string) => string
  inboxDraftId: (now: Date, rand: Uint8Array) => string
  inboxItemOf: (draft: { text: string; type: string; urgency: string; severity?: string }, nowIso: string) => Record<string, unknown>
  inboxConflictOutcome: (existing: unknown, item: Record<string, unknown>, retried: boolean) => 'same' | 'stale' | 'foreign'
  inboxCreateOnce: (db: FakeDb, item: Record<string, unknown>, state: { draftId: string | null; draftSent: boolean }, newId: () => string) => Promise<string | null>
  linkHostNote: (label: string, href: string) => string
  revealInvisible: (s: string) => string
  snapshotIsStale: (rowVersion: number | null, savedVersion: number | undefined) => boolean
  inboxHotkey: (e: Partial<Record<'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', string | boolean>>, mac: boolean) => [string, string] | null
  itemState: (it: { kind: string }, e: Record<string, unknown> | undefined) => 'open' | 'again' | 'done'
  isDone: (it: { kind: string }, e: Record<string, unknown> | undefined) => boolean
  orderItems: <T extends OrderIt>(items: T[], doneOf: ((it: T) => boolean) | null) => T[]
  listOfKind: (kind: string, layout: string) => string
  layoutOf: (saved: unknown) => 'one' | 'sections'
  relayItemState: (relay: unknown, id: string, now: number) => null | { k: 'wait' | 'sending' | 'stuck' | 'off'; session?: string; at?: string; dead?: boolean }
  ownerSnapshotApplies: (local: Record<string, unknown> | undefined, snap: Record<string, unknown> | undefined, pending: boolean) => boolean
  tipHtml: (s: string) => string
  roadmapLabelMode: (pxPerWeek: number) => 'weeks' | 'months'
  roadmapMonthLabel: (d: Date, first: boolean) => string
  placeRoadmapLabels: (items: { x: number; prio: number }[], laneW: number, labelW: number, gap: number) => ('up' | 'dn' | null)[]
  targetFromHash: (hash: string) => string
}
type FakeDb = { doc: (path: string) => { set: (data: unknown, opts?: { ifVersion?: number }) => Promise<unknown>; get: () => Promise<unknown> } }
type Row = { id: string; status?: string; planEnd?: string; basePlanEnd?: string; end?: string }
type OrderIt = { id: string; kind?: string; added?: string; updatedAt?: number }

// Блок из самой страницы (код репозитория, не ввод) исполняется в отдельном контексте vm без доступа к тесту.
function pure(): Pure {
  const a = html.indexOf('/* oq-pure:start')
  const b = html.indexOf('/* oq-pure:end */')
  expect(a).toBeGreaterThan(0)
  expect(b).toBeGreaterThan(a)
  // URL — для сверки доменов в подписях ссылок (linkHostNote): в браузере он есть, в пустом контексте vm — нет.
  const ctx: Record<string, unknown> = createContext({ URL })
  // Правило «открыт ли пункт» page.ts ставит отдельным скриптом до страницы — здесь так же, первым.
  runInContext(OPEN_RULE_JS, ctx)
  runInContext(html.slice(a, b), ctx)
  const fn = <K extends keyof Pure>(name: K): Pure[K] => {
    const v = ctx[name]
    if (typeof v !== 'function') throw new Error(`в блоке oq-pure нет функции ${name}`)
    return v as Pure[K]
  }
  return {
    trackFromDb: fn('trackFromDb'), mergeTracks: fn('mergeTracks'), cleanCards: fn('cleanCards'), cardsLabel: fn('cardsLabel'), cardRowHtml: fn('cardRowHtml'),
    cardsInPlan: fn('cardsInPlan'), statsFromDb: fn('statsFromDb'), lagOf: fn('lagOf'), lagGroups: fn('lagGroups'),
    classifyOwnText: fn('classifyOwnText'), inboxTitleOf: fn('inboxTitleOf'), inboxDraftId: fn('inboxDraftId'), inboxItemOf: fn('inboxItemOf'),
    inboxConflictOutcome: fn('inboxConflictOutcome'), inboxCreateOnce: fn('inboxCreateOnce'), linkHostNote: fn('linkHostNote'),
    revealInvisible: fn('revealInvisible'), inboxHotkey: fn('inboxHotkey'), snapshotIsStale: fn('snapshotIsStale'),
    itemState: fn('itemState'), isDone: fn('isDone'), orderItems: fn('orderItems'), listOfKind: fn('listOfKind'), layoutOf: fn('layoutOf'), relayItemState: fn('relayItemState'), ownerSnapshotApplies: fn('ownerSnapshotApplies'),
    tipHtml: fn('tipHtml'), roadmapLabelMode: fn('roadmapLabelMode'), roadmapMonthLabel: fn('roadmapMonthLabel'),
    placeRoadmapLabels: fn('placeRoadmapLabels'), targetFromHash: fn('targetFromHash'),
  }
}

const SEED = [
  { id: 'tails', name: 'Хвосты и закрытия', c: 'var(--c1)' },
  { id: 'providers', name: 'ИИ-провайдеры', c: 'var(--c2)' },
  { id: 'ops', name: 'Ops-консоль и прод', c: 'var(--c5)' },
]
const hex = (n: number) => n.toString(16).padStart(32, '0')

describe('направления «Хода работ» из базы', () => {
  it('документ track-<id> даёт направление; без имени, с чужим id или kind — отбрасывается', () => {
    const { trackFromDb } = pure()
    expect(trackFromDb('track-ats', { kind: 'track', name: ' ATS и кандидаты ', order: 6 })).toEqual({ id: 'ats', name: 'ATS и кандидаты', c: '', order: 6, archived: false })
    expect(trackFromDb('track-ats', { kind: 'track', name: '' })).toBeNull()
    expect(trackFromDb('ats', { kind: 'track', name: 'ATS' })).toBeNull()
    expect(trackFromDb('track-ATS', { kind: 'track', name: 'ATS' })).toBeNull()
    expect(trackFromDb('track-ats', { kind: 'stats', name: 'ATS' })).toBeNull()
  })

  it('цвет — только токен палитры: иначе в style попала бы произвольная строка из базы', () => {
    const { trackFromDb } = pure()
    expect(trackFromDb('track-x', { kind: 'track', name: 'X', color: 'var(--c6)' })?.c).toBe('var(--c6)')
    for (const bad of ['red', 'var(--c7)', 'var(--c1));background:url(https://evil)', 'url(x)', '#fff']) {
      expect(trackFromDb('track-x', { kind: 'track', name: 'X', color: bad })?.c).toBe('')
    }
  })

  it('базовые направления переименовываются, новые встают по order и получают общий цвет блоков', () => {
    const { trackFromDb, mergeTracks } = pure()
    const list = mergeTracks(SEED, [
      trackFromDb('track-providers', { kind: 'track', name: 'ИИ-платформа и workflow' }),
      trackFromDb('track-ats', { kind: 'track', name: 'ATS и кандидаты', order: 6 }),
      trackFromDb('track-wiki', { kind: 'track', name: 'Wiki', order: 2.5 }),
      trackFromDb('track-old', { kind: 'track', name: 'Старое', order: 7, archived: true }),
      null,
    ])
    expect(list.map((t) => t.id)).toEqual(['tails', 'providers', 'wiki', 'ops', 'ats'])
    expect(list.find((t) => t.id === 'providers')).toMatchObject({ name: 'ИИ-платформа и workflow', c: 'var(--c2)' })
    expect(list.find((t) => t.id === 'ats')?.c).toBe('var(--c6)')
    // Направление-архив скрывает и базовое: строки с ним пропадают из отчёта так же, как с неизвестным направлением.
    expect(mergeTracks(SEED, [trackFromDb('track-tails', { kind: 'track', name: 'Хвосты', archived: true })]).map((t) => t.id)).toEqual(['providers', 'ops'])
  })
})

describe('карточки t-boards в строке плана', () => {
  it('принимает ключ карточки и пространство, без дублей, с обрезкой полей; id прежнего трекера — архив без ссылки', () => {
    const { cleanCards } = pure()
    const out = cleanCards([
      { key: 'OPS-34', ws: 'aiboards-eval', t: 'x'.repeat(400), k: 'bug', s: 'high', st: 'new' },
      { key: 'OPS-34', ws: 'aiboards-eval', t: 'дубль', k: 'bug' },
      { key: 'OPS-34', ws: 'hr-helper-lavaeon', t: 'тот же ключ в другом пространстве', k: 'task' },
      { key: 'javascript:alert(1)', ws: 'aiboards-eval', t: 'плохой ключ', k: 'bug' },
      { key: 'OPS-1', ws: 'Evil Space', t: 'плохое пространство', k: 'bug' },
      { id: hex(7), t: 'строка до досок', k: 'task' },
      null,
      'строка',
    ])
    expect(out.map((c) => [c.key, c.ws, c.archived])).toEqual([
      ['OPS-34', 'aiboards-eval', false],
      ['OPS-34', 'hr-helper-lavaeon', false],
      ['', '', true],
    ])
    expect(out[0]?.t).toHaveLength(160)
    expect(cleanCards('не массив')).toEqual([])
  })

  it('закрывающие колонки — и русские названия, и slug досок; «на ревью» — и in-review', () => {
    const { cleanCards } = pure()
    const out = cleanCards(['закрыто', 'done', 'closed', 'in-review', 'на ревью', 'new'].map((st, i) => ({ key: `OPS-${i + 1}`, ws: 'aiboards-eval', st })))
    expect(out.filter((c) => c.closed)).toHaveLength(3)
    expect(out.filter((c) => c.review)).toHaveLength(2)
  })

  it('порядок: открытые раньше закрытых, ошибки раньше задач, внутри — по severity/priority', () => {
    const { cleanCards } = pure()
    const out = cleanCards([
      { id: hex(1), t: 'задача P1', k: 'task', s: 'P1', st: 'задача от пользователя' },
      { id: hex(2), t: 'ошибка low', k: 'bug', s: 'low', st: 'открыто' },
      { id: hex(3), t: 'ошибка закрыта', k: 'bug', s: 'critical', st: 'закрыто' },
      { id: hex(4), t: 'ошибка critical', k: 'bug', s: 'critical', st: 'в работе' },
      { id: hex(5), t: 'задача завершена', k: 'task', s: 'P0', st: 'завершённые' },
    ])
    expect(out.map((c) => c.t)).toEqual(['ошибка critical', 'ошибка low', 'задача P1', 'ошибка закрыта', 'задача завершена'])
    expect(out.filter((c) => c.closed)).toHaveLength(2)
  })

  it('подпись кнопки — по-русски, с числом закрытых', () => {
    const { cleanCards, cardsLabel } = pure()
    const make = (n: number, closed = 0) => cleanCards(Array.from({ length: n }, (_, i) => ({ id: hex(i + 1), k: 'bug', st: i < closed ? 'закрыто' : 'открыто' })))
    expect(cardsLabel(make(1))).toBe('1 карточка')
    expect(cardsLabel(make(3, 1))).toBe('3 карточки · закрыто 1')
    expect(cardsLabel(make(11))).toBe('11 карточек')
    expect(cardsLabel(make(22, 22))).toBe('22 карточки · закрыто 22')
    expect(cardsLabel(make(25))).toBe('25 карточек')
  })

  it('строка окна карточек: заголовок, статус и severity из данных — текстом, не разметкой (ревью «Контроля» #239)', () => {
    const { cardRowHtml } = pure()
    const row = cardRowHtml({ id: hex(1), key: 'APP-7', ws: 'w"s', k: 'bug', t: '<b>x</b>', s: '"><img src=x>', st: '<i>st</i>', c: '<a href="https://evil.org">c</a>' })
    expect(row).not.toMatch(/<b>|<img|<i>|href="https:\/\/evil/)
    expect(row).toContain('APP-7 &lt;b&gt;x&lt;/b&gt;')
    expect(row).toContain('class="sev sev-&quot;&gt;&lt;img src=x&gt;"')
    // Ссылка t-boards экранирована: кавычка из ws не закрывает атрибут href.
    expect(row).toContain('<a href="https://d4dev.admin.hrhelper.space/w&quot;s/task/APP-7" target="_blank" rel="noopener">')
    // Без ключа t-boards (архивная карточка Notion) — текст без ссылки.
    const archived = cardRowHtml({ id: hex(2), k: 'task', closed: true, t: '<b>y</b>' })
    expect(archived).toMatch(/^<li class="is-closed"><span class="sev sev-none">задача<\/span><span>&lt;b&gt;y&lt;\/b&gt; \(архив\)<\/span>/)
    expect(archived).not.toContain('<a ')
    // Ключ в обход cleanCards — ссылка и подпись тоже текстом: без esc(url) тест падает (линза #111).
    expect(cardRowHtml({ id: hex(3), key: '"><img src=y>', ws: 'w', k: 'task' })).not.toContain('"><img')
  })
})

describe('карточки в плане: со сроком, без срока, ждут владельца', () => {
  it('закрытые не считаются; строка владельца — «ждут», строка агента с planEnd — «со сроком»', () => {
    const { cleanCards, cardsInPlan } = pure()
    const c = (n: number, st = 'открыто') => cleanCards(Array.from({ length: n }, (_, i) => ({ key: `OPS-${i + 1 + n * 100}`, ws: 'aiboards-eval', k: 'bug', st })))
    expect(cardsInPlan([
      { who: 'agent', planEnd: '2026-11-12', cards: [...c(3), ...c(2, 'закрыто')] },
      { who: 'agent', cards: c(4) },
      { who: 'owner', planEnd: '2026-11-12', cards: c(5) },
      { who: 'agent', planEnd: '2026-11-12' },
      // Карточки прежнего трекера (архив) — не в счёт.
      { who: 'agent', planEnd: '2026-11-12', cards: cleanCards([{ id: hex(9), k: 'bug', st: 'открыто' }]) },
    ])).toEqual({ dated: 3, undated: 4, owner: 5 })
  })
})

describe('сводка сверки с досками', () => {
  it('только kind=stats; числа неотрицательные и целые; история — по датам', () => {
    const { statsFromDb } = pure()
    expect(statsFromDb({ kind: 'track' })).toBeNull()
    const st = statsFromDb({
      kind: 'stats', bugs: { critical: 1, high: '10', medium: -3, low: 2.6 }, tasks: { P0: 8 }, inPlan: 428, notInPlan: 'x',
      history: [{ d: '2026-10-20', bugs: 251, tasks: 218 }, { d: '20.10.2026', bugs: 1 }, null],
    })
    expect(st?.bugs).toEqual({ critical: 1, high: 10, medium: 0, low: 3, none: 0 })
    expect(st?.tasks).toEqual({ P0: 8, P1: 0, P2: 0, P3: 0, none: 0 })
    expect(st?.inPlan).toBe(428)
    expect(st?.notInPlan).toBe(0)
    expect(st?.history).toEqual([{ d: '2026-10-20', bugs: 251, tasks: 218, inPlan: 0 }])
  })
})

describe('отставание от плана: просрочено сейчас и закрыто не в срок', () => {
  const today = new Date(2026, 9, 21)
  const ids = (rs: { w: Row }[]) => rs.map((r) => r.w.id)

  it('открытая строка позже плана растёт до сегодня; сдвиг считается от basePlanEnd', () => {
    const { lagOf } = pure()
    expect(lagOf({ id: 'a', status: 'blocked', planEnd: '2026-10-12' }, today)).toBe(9)
    expect(lagOf({ id: 'b', status: 'doing', planEnd: '2026-10-21', basePlanEnd: '2026-10-16' }, today)).toBe(5)
    expect(lagOf({ id: 'c', status: 'doing', planEnd: '2026-10-25' }, today)).toBe(0)
  })

  it('«сделано» без даты факта не растёт бесконечно: после плана — неизвестно, до конца плана — в срок', () => {
    const { lagOf } = pure()
    expect(lagOf({ id: 'rev174', status: 'done', planEnd: '2026-10-16' }, today)).toBeNull()
    expect(lagOf({ id: 'early', status: 'done', planEnd: '2026-10-25' }, today)).toBe(0)
    expect(lagOf({ id: 'x', status: 'done', planEnd: '2026-10-15', end: '2026-10-16' }, today)).toBe(1)
  })

  it('открытые позже плана — в «просрочено сейчас», закрытые со сдвигом — отдельно, в срок — только счётчик', () => {
    const { lagGroups } = pure()
    const g = lagGroups([
      { id: 'watchdog', status: 'blocked', planEnd: '2026-10-12' },
      { id: 'oe', status: 'doing', planEnd: '2026-10-21', basePlanEnd: '2026-10-16' },
      { id: 'styles', status: 'done', planEnd: '2026-10-11', end: '2026-10-16' },
      { id: 'early', status: 'done', planEnd: '2026-10-20', end: '2026-10-18' },
      { id: 'ontime', status: 'done', planEnd: '2026-10-19', end: '2026-10-19' },
      { id: 'future', status: 'planned', planEnd: '2026-10-30' },
      { id: 'no-end', status: 'done', planEnd: '2026-10-16' },
      { id: 'no-plan', status: 'doing' },
      // Дата факта при незакрытом статусе: сдвиг уже итоговый — не теряется и не считается «просрочено сейчас».
      { id: 'end-not-done', status: 'doing', planEnd: '2026-10-20', end: '2026-10-18' },
    ], today)
    expect(ids(g.open)).toEqual(['watchdog', 'oe'])
    expect(ids(g.closed)).toEqual(['styles', 'early', 'end-not-done'])
    expect(g.closed.map((r) => r.lag)).toEqual([5, -2, -2])
    expect(g.onTime).toBe(2)
  })

  it('раскрытый список закрытых переживает перерисовку', () => {
    const fn = html.slice(html.indexOf('function lagChart('), html.indexOf('function lagRow('))
    expect(fn).toMatch(/querySelector\('details\.hb-closed'\)[\s\S]*\.open/)
    expect(fn).toContain("(wasOpen ? ' open' : '')")
  })

  it('строки «просрочено сейчас» — прямые дети #ch-lag, закрытые — внутри <details>: бот берёт только первые', () => {
    const fn = html.slice(html.indexOf('function lagChart('), html.indexOf('function lagRow('))
    expect(fn).toContain("g.open.map(row)")
    expect(fn.indexOf('g.open.map(row)')).toBeLessThan(fn.indexOf('<details'))
    expect(fn).toMatch(/<details class="hb-closed"[\s\S]*g\.closed\.map\(row\)[\s\S]*<\/details>/)
    const bot = readFileSync(join(__dirname, '../../owner-queue-bot/frame-scripts.mjs'), 'utf8')
    expect(bot).toContain("querySelectorAll('#ch-lag > .hb')")
  })
})

describe('совместимость с ботом очереди', () => {
  it('кнопка карточек в отчёте — не ссылка (бот берёт первую <a> ячейки), окно — вне #report', () => {
    expect(html).toMatch(/class="cards-btn"/)
    expect(html).not.toMatch(/<a[^>]*class="cards-btn"/)
    const report = html.indexOf('id="report"')
    const dialog = html.indexOf('id="cards-dlg"')
    expect(dialog).toBeGreaterThan(report)
    expect(html.slice(report, dialog)).toContain('</table>')
  })

  it('«Как пользоваться» — внутри <header>: бот читает его как header .howto', () => {
    const howto = html.indexOf('<div class="howto">')
    expect(howto).toBeGreaterThan(0)
    expect(html.lastIndexOf('<header', howto)).toBeGreaterThan(html.lastIndexOf('</header>', howto))
  })

  it('на время скриншотов бот сужает .wrap — две колонки выключаются, а с 1400 px включаются даже с полосой прокрутки', () => {
    // Бот снимает карточки «Хода работ» в одну колонку (owner-queue-bot/frame-scripts.mjs, setShotLayout).
    const bot = readFileSync(join(__dirname, '../../owner-queue-bot/frame-scripts.mjs'), 'utf8')
    const shotWrap = Number(/\.wrap\s*\{\s*max-width:\s*(\d+)px/.exec(bot)?.[1])
    const threshold = Number(/@container page \(min-width: (\d+)px\)/.exec(html)?.[1])
    const pad = Number(/\.wrap \{[^}]*padding-inline: (\d+)px/.exec(html)?.[1])
    const wide = Number(/@media \(min-width: (\d+)px\) \{ \.wrap \{ max-width: \d+px/.exec(html)?.[1])
    expect([shotWrap, threshold, pad, wide].every((n) => n > 0)).toBe(true)
    expect(wide).toBe(1400)
    expect(shotWrap - 2 * pad).toBeLessThan(threshold)
    expect(wide - 17 - 2 * pad).toBeGreaterThanOrEqual(threshold) // 17 px — классическая полоса прокрутки (Windows)
  })

  it('без поддержки @container .wrap не расширяется: одна колонка до 880 px, а не данные на всю ширину окна', () => {
    expect(html.match(/max-width: 1880px/g)).toHaveLength(1)
    expect(html).toMatch(/@supports \(container-type: inline-size\) \{ @media \(min-width: 1400px\) \{ \.wrap \{ max-width: 1880px; \} \} \}/)
  })
})

describe('раскладка: отчёты слева или выше, данные справа или ниже', () => {
  const at = (needle: string) => {
    const i = html.indexOf(needle)
    expect(i, needle).toBeGreaterThan(0)
    expect(html.indexOf(needle, i + 1), `${needle} — не один раз`).toBe(-1)
    return i
  }

  it('порядок в DOM совпадает с экранным: заголовок → «Ход работ» → данные; справка агентов и подвал — в конце данных', () => {
    const order = ['<header class="page-head">', '<a class="skip" href="#queue-data">', 'id="reports-col"', 'id="agents"', 'id="report-card"', 'id="cards-dlg"',
      'class="col-data"', '<header class="data-head" id="queue-data">', '<div class="howto">', 'id="sec-queue"', 'id="sec-decision"', 'id="sec-merge"', 'id="sec-server"',
      'id="sec-check"', '<details class="agent-howto">', '<footer>']
    const idx = order.map(at)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('колонка отчётов — region с подписью, фокусируемая с клавиатуры', () => {
    expect(html).toMatch(/<div class="col-reports" id="reports-col" role="region" aria-label="[^"]+" tabindex="0">/)
  })

  it('первая остановка Tab — ссылка к данным: открытый отчёт (сотня кнопок и ссылок) не стоит между владельцем и пунктами', () => {
    const main = at('<main class="wrap">')
    const before = html.slice(main, at('<a class="skip" href="#queue-data">'))
    expect(before).not.toMatch(/<(a|button|input|select|textarea|summary|details)\b|tabindex=/)
    expect(html).toMatch(/\.skip \{[^}]*position: fixed;[^}]*transform: translateY\(-200%\);/)
    expect(html).toMatch(/\.skip:focus \{ transform: none;/)
  })

  it('длинная строка в тексте пункта (путь, команда) переносится, а не раздвигает страницу на телефоне', () => {
    expect(html).toMatch(/\.item-body \{[^}]*overflow-wrap: anywhere;/)
  })

  it('«Отчёт по задачам» — последняя карточка «Хода работ», свёрнута, с h3 в заголовке (по нему бот не снимает её картинкой)', () => {
    const dash = html.slice(at('id="agents"'), at('class="col-data"'))
    const rep = dash.indexOf('<details class="card rep-card" id="report-card">')
    expect(rep).toBeGreaterThan(0)
    expect(dash.slice(rep).match(/class="card[ "]/g)).toHaveLength(1)
    expect(dash.slice(rep, dash.indexOf('</details>', rep))).toContain('<summary><h3>Отчёт по задачам</h3>')
    expect(dash.slice(rep, dash.indexOf('</details>', rep))).toContain('<table class="rep" id="report"></table>')
  })
})

describe('«ждёт вас снова»: страница решает тем же правилом, что сервер (?open=1)', () => {
  const T0 = '2026-10-22T10:00:00.000Z'
  const T1 = '2026-10-22T10:05:00.000Z'
  const answered = { choice: 'yes', done: true, note: '', at: T0 }

  it('ответ владельца, потом blocked — пункт среди открытых; потом doing, done или planned — в выполненных', () => {
    const { itemState, isDone } = pure()
    expect(itemState({ kind: 'decision' }, { ...answered, agentStatus: 'blocked', agentAt: T1 })).toBe('again')
    expect(isDone({ kind: 'decision' }, { ...answered, agentStatus: 'blocked', agentAt: T1 })).toBe(false)
    expect(isDone({ kind: 'server' }, { done: true, at: T0, agentStatus: 'blocked', agentAt: T1 })).toBe(false)
    for (const st of ['doing', 'done', 'planned']) expect(isDone({ kind: 'decision' }, { ...answered, agentStatus: st, agentAt: T1 }), st).toBe(true)
    // Ответ после blocked закрывает пункт снова; документа ответа нет — пункт открыт.
    expect(isDone({ kind: 'decision' }, { ...answered, at: T1, agentStatus: 'blocked', agentAt: T0 })).toBe(true)
    expect(isDone({ kind: 'check' }, undefined)).toBe(false)
  })

  it('отрисовка: «снова» — метка в строке чипов и снятая галочка (одно нажатие «Сделано» — новый ответ)', () => {
    // render() живёт в DOM-части страницы — сверяем, что он берёт состояние из правила и отдаёт его метке и галочке.
    expect(html).toContain('var st = itemState(it, e), d = st === \'done\', again = st === \'again\';')
    expect(html).toContain('markAgain(el, again);')
    expect(html).toContain('cb.checked = !!e.done && !again;')
    expect(html).toContain('<span class="chip chip-again">ждёт вас снова</span>')
  })
})

describe('снимок опроса не откатывает несохранённый ответ владельца (линза GLM #214)', () => {
  const T1 = '2026-10-23T00:10:00.000Z'
  const T2 = '2026-10-23T00:11:00.000Z'

  it('apply() спрашивает правило: в полёте, грязная правка и ошибка сохранения — «своя правка ещё не дошла»', () => {
    expect(html).toContain('if (ownerSnapshotApplies(e, r.data, !!inflight[r.id] || !!dirty[r.id] || !!saveErr[r.id] || !!e.pending)) {')
    // Устаревшая правка снимается и по снимку, и по 409; несохранённое после перезагрузки повторяется (ревью #324).
    expect(html).toContain("if (e.pending && !inflight[r.id] && snapAt !== (e.base || '') && snapAt !== (e.at || '')) dropStaleEdit(r.id);")
    expect(html).toContain('if (err && err.status === 409) dropStaleEdit(id);')
    // Снимок, снятый до своего сохранения, не откатывает базу правки (ревью #324, minor): строка старше версии записи.
    const { snapshotIsStale } = pure()
    expect(snapshotIsStale(4, 5)).toBe(true)
    expect(snapshotIsStale(5, 5)).toBe(false)
    expect(snapshotIsStale(6, 5)).toBe(false)
    expect(snapshotIsStale(null, 5)).toBe(false)
    expect(snapshotIsStale(4, undefined)).toBe(false)
    expect(html).toContain('if (snapshotIsStale(r.version, savedVersion[r.id])) return;')
    expect(html).toContain("if (res && typeof res.version === 'number') savedVersion[id] = res.version;")
    // Версию до страницы доносит подмена базы: без неё проверка молча не работала бы.
    expect(SHIM_JS).toContain('return { id: d.id, data: d.data, version: d.version, product: d.product, updatedAt: d.updatedAt };')
    expect(html).toContain('Object.keys(state).forEach(function (id) { if (state[id] && state[id].pending) persist(id); });')
  })

  it('своя правка сохраняется, ждёт повтора или не удалась — ответ из снимка не берётся', () => {
    const { ownerSnapshotApplies } = pure()
    expect(ownerSnapshotApplies({ note: 'новая', at: T2 }, { note: 'старая', at: T2 }, true)).toBe(false)
  })

  it('своя правка новее снимка — снимок снят до сохранения, не берётся; снимок новее или тот же — берётся', () => {
    const { ownerSnapshotApplies } = pure()
    expect(ownerSnapshotApplies({ note: 'новая', at: T2 }, { note: 'старая', at: T1 }, false)).toBe(false)
    expect(ownerSnapshotApplies({ note: 'старая', at: T1 }, { note: 'с телефона', at: T2 }, false)).toBe(true)
    expect(ownerSnapshotApplies({ note: 'та же', at: T2 }, { note: 'та же', at: T2 }, false)).toBe(true)
    // Своего ответа ещё не было — снимок берётся; свой есть, а в снимке времени нет — свой не затирается.
    expect(ownerSnapshotApplies({}, { done: true, at: T1 }, false)).toBe(true)
    expect(ownerSnapshotApplies(undefined, { done: true, at: T1 }, false)).toBe(true)
    expect(ownerSnapshotApplies({ done: true, at: T2 }, { agentStatus: 'doing' }, false)).toBe(false)
  })
})

describe('автопередача входящих на странице: честно, жива ли и кому передано', () => {
  const NOW = Date.parse('2026-10-23T00:30:00.000Z')
  const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
  const alive = { session: 'hr-helper-v2-43', at: at(0.5), alive: true }
  const dead = { session: 'hr-helper-v2-43', at: at(30), alive: false }

  it('процесс жив: передано — ждём «взял»; ещё не передано — «передаётся»', () => {
    const { relayItemState } = pure()
    const relay = { alive: true, sessions: [alive], relayed: { 'i-1': { session: 'hr-helper-v2-43', at: at(2) } } }
    expect(relayItemState(relay, 'i-1', NOW)).toEqual({ k: 'wait', session: 'hr-helper-v2-43', at: at(2) })
    expect(relayItemState(relay, 'i-2', NOW)).toEqual({ k: 'sending', session: 'hr-helper-v2-43' })
  })

  it('передано, но «взял» нет 10 минут или процесс умер — ждать некого: команда руками', () => {
    const { relayItemState } = pure()
    const slow = { alive: true, sessions: [alive], relayed: { 'i-1': { session: 'hr-helper-v2-43', at: at(11) } } }
    expect(relayItemState(slow, 'i-1', NOW)).toMatchObject({ k: 'stuck', dead: false })
    const died = { alive: false, sessions: [dead], relayed: { 'i-1': { session: 'hr-helper-v2-43', at: at(2) } } }
    expect(relayItemState(died, 'i-1', NOW)).toMatchObject({ k: 'stuck', dead: true })
  })

  it('автопередачи нет или не включена — «не работает»; консоль без /relay — ничего не говорим', () => {
    const { relayItemState } = pure()
    expect(relayItemState({ alive: false, sessions: [dead], relayed: {} }, 'i-1', NOW)).toEqual({ k: 'off' })
    expect(relayItemState({ alive: false, sessions: [], relayed: {} }, 'i-1', NOW)).toEqual({ k: 'off' })
    expect(relayItemState(null, 'i-1', NOW)).toBeNull()
    expect(relayItemState({ sessions: 'x', relayed: {} }, 'i-1', NOW)).toBeNull()
    // Служебные имена объекта не принимаются за «передано».
    expect(relayItemState({ alive: true, sessions: [alive], relayed: {} }, 'constructor', NOW)).toEqual({ k: 'sending', session: 'hr-helper-v2-43' })
  })
})

describe('форма «Поставить задачу»: те же правила, что у бота', () => {
  // Набор фраз владельца: по нему копия правил на странице не должна разойтись с ботом (infra/owner-queue-bot).
  const PHRASES = [
    'На проде 502 у всех',
    'не грузится страница интеграций',
    'Ошибка при сохранении вакансии',
    'белый экран после деплоя — срочно',
    'Идея: экспорт в Excel',
    'хорошо бы добавить фильтр по отделу',
    'а что если показывать карточки провайдеров',
    'Добавить поле «отдел»',
    'Проверь вебхуки hh',
    '🔴 Алерт: распознавание встреч горит',
    '🟠 инцидент с Redis',
    '🟢 ВОССТАНОВЛЕНО: алерт закрыт',
    '🔴 просто красный кружок без слов',
    'Баг: bug в error-логе',
    'Хочу отчёт по найму',
    '',
  ]

  it('горячие клавиши: по коду клавиши; Mac — Ctrl, Windows и Linux — Ctrl или Alt, но не AltGr', () => {
    const { inboxHotkey } = pure()
    // Русская раскладка: e.key — «и», код — KeyB; сочетание то же.
    expect(inboxHotkey({ code: 'KeyB', ctrlKey: true }, true)).toEqual(['type', 'bug'])
    expect(inboxHotkey({ code: 'KeyI', ctrlKey: true }, true)).toEqual(['type', 'idea'])
    expect(inboxHotkey({ code: 'KeyT', ctrlKey: true }, true)).toEqual(['type', 'task'])
    expect(inboxHotkey({ code: 'KeyA', ctrlKey: true }, true)).toEqual(['type', 'alert'])
    expect(inboxHotkey({ code: 'KeyN', ctrlKey: true }, true)).toEqual(['urgency', 'now'])
    expect(inboxHotkey({ code: 'KeyQ', ctrlKey: true }, true)).toEqual(['urgency', 'queue'])
    expect(inboxHotkey({ code: 'Digit1', ctrlKey: true }, true)).toEqual(['severity', 'critical'])
    expect(inboxHotkey({ code: 'Numpad4', ctrlKey: true }, true)).toEqual(['severity', 'low'])
    // Mac: Option печатает символы — не наше, и вместе с Ctrl тоже; ⌘ и Shift — тоже.
    expect(inboxHotkey({ code: 'KeyB', altKey: true }, true)).toBeNull()
    expect(inboxHotkey({ code: 'KeyB', ctrlKey: true, altKey: true }, true)).toBeNull()
    expect(inboxHotkey({ code: 'KeyB', ctrlKey: true, metaKey: true }, true)).toBeNull()
    expect(inboxHotkey({ code: 'KeyB', ctrlKey: true, shiftKey: true }, true)).toBeNull()
    // Windows и Linux: Ctrl+T и Ctrl+N до страницы не доходят — работает Alt; Ctrl+Alt — это AltGr, символ.
    expect(inboxHotkey({ code: 'KeyT', altKey: true }, false)).toEqual(['type', 'task'])
    expect(inboxHotkey({ code: 'KeyN', altKey: true }, false)).toEqual(['urgency', 'now'])
    expect(inboxHotkey({ code: 'KeyB', ctrlKey: true }, false)).toEqual(['type', 'bug'])
    expect(inboxHotkey({ code: 'KeyQ', ctrlKey: true, altKey: true }, false)).toBeNull()
    // Без модификатора и чужие клавиши — не сочетание.
    expect(inboxHotkey({ code: 'KeyB' }, true)).toBeNull()
    expect(inboxHotkey({ code: 'KeyZ', ctrlKey: true }, true)).toBeNull()
    expect(inboxHotkey({ code: 'Digit5', ctrlKey: true }, true)).toBeNull()
    expect(inboxHotkey({ code: 'constructor', ctrlKey: true }, true)).toBeNull()
  })

  it('догадка совпадает с ботом для своего (не пересланного) сообщения — на каждой фразе', async () => {
    const { classifyOwnText } = pure()
    // @ts-expect-error — модуль бота на чистом JS (infra/owner-queue-bot), типов у него нет
    const bot = await import('../../owner-queue-bot/classify.mjs')
    for (const text of PHRASES) expect(classifyOwnText(text), text).toEqual(bot.classify({ text }))
  })

  it('заголовок пункта — как у бота; невидимые символы вычищаются из текста', async () => {
    const { inboxTitleOf, inboxItemOf } = pure()
    // @ts-expect-error — модуль бота на чистом JS
    const bot = await import('../../owner-queue-bot/classify.mjs')
    for (const text of ['  \n🔴 Первая строка\nвторая', 'x'.repeat(200), 'Одна строка']) expect(inboxTitleOf(text)).toBe(bot.titleOf(text))
    const item = inboxItemOf({ text: 'Ска​зка⁦', type: 'task', urgency: 'queue' }, '2026-10-21T12:00:00.000Z')
    expect((item.inbox as { text: string }).text).toBe('Сказка')
    // Та же вычистка, что у бота (textOf): приватная зона и селекторы вариантов тоже вон.
    const tricky = 'За\u{E000}да\u{E0101}ча\u{E0041}'
    expect((inboxItemOf({ text: tricky, type: 'task', urgency: 'queue' }, '2026-10-21T12:00:00.000Z').inbox as { text: string }).text).toBe(bot.textOf({ text: tricky }))
  })

  it('id — в формате бота i-<дата>-<время UTC>-<4 hex>', () => {
    const { inboxDraftId } = pure()
    expect(inboxDraftId(new Date(Date.UTC(2026, 9, 21, 9, 5, 7)), new Uint8Array([0xab, 0x0c]))).toBe('i-20261021-090507-ab0c')
  })

  it('пункт формы: свой текст (originKind self, не переслан), source queue-page, важность — только у ошибки и алерта', () => {
    const { inboxItemOf } = pure()
    const bug = inboxItemOf({ text: 'Не открывается /queue', type: 'bug', urgency: 'now', severity: 'high' }, '2026-10-21T12:00:00.000Z')
    expect(bug).toMatchObject({ kind: 'inbox', title: 'Не открывается /queue', source: 'queue-page', added: '2026-10-21' })
    expect(bug.inbox).toEqual({
      type: 'bug', urgency: 'now', severity: 'high', text: 'Не открывается /queue',
      origin: 'сам (страница очереди)', originKind: 'self', forwarded: false, receivedAt: '2026-10-21T12:00:00.000Z',
    })
    const idea = inboxItemOf({ text: 'Идея', type: 'idea', urgency: 'queue', severity: 'high' }, '2026-10-21T12:00:00.000Z')
    expect(idea.inbox).not.toHaveProperty('severity')
  })

  it('создание — только один раз (ifVersion 0); 409 сверяется с тем, что уже лежит под id, а не считается успехом', () => {
    const block = html.slice(html.indexOf('/* oq-pure:start'), html.indexOf('/* oq-pure:end */'))
    expect(block).toContain("set(item, { ifVersion: 0 })")
    expect(block).toMatch(/err\.status !== 409\) throw err/)
    expect(block).toContain("db.doc('items/' + id).get()")
    const composer = html.slice(html.indexOf('var composer = (function'), html.indexOf('return {\n      enable:'))
    expect(composer).toContain('await inboxCreateOnce(db, item, send, newId)')
    const shim = readFileSync(join(__dirname, '../server/queue/page-scripts.ts'), 'utf8')
    expect(shim).toMatch(/ifVersion: opts\.ifVersion/)
    expect(shim).toMatch(/err\.status = res\.status/)
    expect(shim).toMatch(/get: function \(\) \{\s*return fetch\(BASE \+ col \+ '\/' \+ encodeURIComponent\(id\)/)
  })

  it('409: своя прошлая попытка с тем же текстом — принято; с прежним текстом — сказать; чужой пункт или первая отправка — новый id (линзы GLM #290)', () => {
    const { inboxConflictOutcome, inboxItemOf } = pure()
    const now = '2026-10-21T12:00:00.000Z'
    const mine = inboxItemOf({ text: 'Проверить деплой', type: 'task', urgency: 'queue' }, now)
    const edited = inboxItemOf({ text: 'Проверить деплой и пробу', type: 'task', urgency: 'queue' }, now)
    expect(inboxConflictOutcome(mine, mine, true)).toBe('same')
    // Ответ первой попытки потерялся, владелец дописал текст: дописанное не сохранено — не «принято».
    expect(inboxConflictOutcome(mine, edited, true)).toBe('stale')
    // На первой отправке 409 — только совпадение id, даже если пункт тоже со страницы очереди.
    expect(inboxConflictOutcome(mine, mine, false)).toBe('foreign')
    const bot = { kind: 'inbox', source: 'telegram-bot', inbox: { text: 'Проверить деплой' } }
    expect(inboxConflictOutcome(bot, mine, true)).toBe('foreign')
    expect(inboxConflictOutcome({ source: 'queue-page' }, mine, true)).toBe('foreign')
    expect(inboxConflictOutcome(null, mine, true)).toBe('foreign')
  })

  describe('отправка формы на фальшивой базе (линзы GLM #290)', () => {
    const NOW = '2026-10-21T12:00:00.000Z'
    // База как у сервера: ifVersion 0 на существующем — 409; loseResponse — запись дошла, ответ потерялся.
    function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
      const docs = new Map<string, Record<string, unknown>>(Object.entries(seed))
      let loseResponse = false
      const db: FakeDb = {
        doc: (path) => ({
          set: async (data, opts) => {
            if (opts?.ifVersion === 0 && docs.has(path)) throw Object.assign(new Error('Конфликт версии'), { status: 409 })
            docs.set(path, data as Record<string, unknown>)
            if (loseResponse) {
              loseResponse = false
              throw new Error('Failed to fetch')
            }
            return { ok: true }
          },
          get: async () => {
            const data = docs.get(path)
            if (!data) throw Object.assign(new Error('Нет такого документа'), { status: 404 })
            return { id: path, data, version: 1 }
          },
        }),
      }
      return { db, docs, loseNext: () => { loseResponse = true } }
    }
    const task = (text: string) => pure().inboxItemOf({ text, type: 'task', urgency: 'queue' }, NOW)

    it('обычная отправка — пункт создан под id черновика', async () => {
      const { inboxCreateOnce } = pure()
      const { db, docs } = fakeDb()
      const state = { draftId: 'i-1', draftSent: false }
      expect(await inboxCreateOnce(db, task('Проверить деплой'), state, () => 'i-x')).toBe('i-1')
      expect(docs.size).toBe(1)
    })

    it('ответ потерялся, повтор с тем же текстом — «принято», второго пункта нет', async () => {
      const { inboxCreateOnce } = pure()
      const { db, docs, loseNext } = fakeDb()
      const state = { draftId: 'i-1', draftSent: false }
      loseNext()
      await expect(inboxCreateOnce(db, task('Проверить деплой'), state, () => 'i-x')).rejects.toThrow('Failed to fetch')
      expect(await inboxCreateOnce(db, task('Проверить деплой'), state, () => 'i-x')).toBe('i-1')
      expect(docs.size).toBe(1)
    })

    it('ответ потерялся, владелец дописал текст — не «принято»: null, в базе старый текст, id для сообщения на месте', async () => {
      const { inboxCreateOnce } = pure()
      const { db, docs, loseNext } = fakeDb()
      const state = { draftId: 'i-1', draftSent: false }
      loseNext()
      await expect(inboxCreateOnce(db, task('Проверить деплой'), state, () => 'i-x')).rejects.toThrow()
      expect(await inboxCreateOnce(db, task('Проверить деплой и пробу'), state, () => 'i-x')).toBeNull()
      expect((docs.get('items/i-1') as { inbox: { text: string } }).inbox.text).toBe('Проверить деплой')
      expect(state.draftId).toBe('i-1')
    })

    it('id занят пунктом бота — пункт бота не тронут, задача создана под новым id', async () => {
      const { inboxCreateOnce } = pure()
      const botItem = { kind: 'inbox', source: 'telegram-bot', inbox: { text: 'Пересланное' } }
      const { db, docs } = fakeDb({ 'items/i-1': botItem })
      const state = { draftId: 'i-1', draftSent: false }
      expect(await inboxCreateOnce(db, task('Проверить деплой'), state, () => 'i-2')).toBe('i-2')
      expect(docs.get('items/i-1')).toBe(botItem)
      expect(state).toEqual({ draftId: 'i-2', draftSent: true })
    })

    it('и новый id занят — ошибка, а не «принято»', async () => {
      const { inboxCreateOnce } = pure()
      const bot = { kind: 'inbox', source: 'telegram-bot', inbox: { text: 'x' } }
      const { db } = fakeDb({ 'items/i-1': bot, 'items/i-2': bot })
      await expect(inboxCreateOnce(db, task('Проверить деплой'), { draftId: 'i-1', draftSent: false }, () => 'i-2')).rejects.toThrow('номер задачи занят')
    })
  })

  it('на странице нет устаревших статичных сводок, перенесённых из артефакта (входящее i-20261021-131419-3e59)', () => {
    expect(html).not.toContain('16.10, ждёт вас')
    expect(html).not.toContain('Что сверено:')
    expect(html).not.toMatch(/Сверено \d{2}\.\d{2}\.\d{4}/)
    expect(html).not.toContain('done-today')
  })

  it('во время отправки кнопки типа, срочности и важности недоступны, клик по ним игнорируется (линзы GLM #290)', () => {
    const composer = html.slice(html.indexOf('var composer = (function'), html.indexOf('return {\n      enable:'))
    expect(composer).toContain('b.disabled = busy;')
    expect(composer).toContain('if (!b || busy) return;')
  })

  it('без поддержки (?<!…) в браузере правила работают через запасную границу слова', () => {
    // Старый Safari: ретроспективная проверка недоступна — исполняем блок с подменённым RegExp, который её отвергает.
    const a = html.indexOf('/* oq-pure:start')
    const b = html.indexOf('/* oq-pure:end */')
    const NoLookbehind = function (src: string, flags?: string) {
      if (src.includes('(?<')) throw new SyntaxError('Invalid regular expression: lookbehind')
      return new RegExp(src, flags)
    } as unknown as RegExpConstructor
    const ctx: Record<string, unknown> = createContext({ RegExp: NoLookbehind })
    runInContext(html.slice(a, b), ctx)
    const classify = ctx.classifyOwnText as (t: string) => { type: string; urgency: string }
    expect(classify('На проде 502 у всех')).toMatchObject({ type: 'bug', urgency: 'now' })
    expect(classify('Идея: экспорт')).toMatchObject({ type: 'idea' })
    expect(classify('Добавить поле')).toMatchObject({ type: 'task' })
  })

  it('форма — в самом верху страницы, до «Хода работ» и до пунктов очереди', () => {
    const compose = html.indexOf('id="compose"')
    expect(compose).toBeGreaterThan(html.indexOf('class="page-head"'))
    expect(compose).toBeLessThan(html.indexOf('id="agents"'))
    expect(compose).toBeLessThan(html.indexOf('id="queue-data"'))
  })
})

describe('ссылки в пунктах: подпись не выдаёт себя за другой адрес (GLM-ревью #213)', () => {
  const CASES: [string, string][] = [
    ['github.com', 'https://ithub.com/x'],
    ['evil.com.github.com', 'https://evil.com/x'],
    ['gist.github.com', 'https://github.com/x'],
    ['github.com', 'https://www.github.com/x'],
    ['github.com', 'https://gіthub.com/x'],
    ['gíthub.com', 'https://xn--gthub-zsa.com/'],
    ['GitHub.COM', 'https://github.com/x'],
    ['https://github.com/a/b', 'https://github.com/a/b'],
    ['PR на github.com', 'https://github.com/a/b'],
    ['github.com или gitlab.com', 'https://github.com/a'],
    ['Инцидент #5', 'https://ops.example/i/5'],
    ['версия 1.2.3', 'https://github.com/'],
    ['docs/ops/csp.md', 'https://github.com/a/blob/main/docs/ops/csp.md'],
    ['README.md', 'https://github.com/a'],
    ['github.com/agolubenk/agolubenk.github.io', 'https://github.com/agolubenk/agolubenk.github.io'],
    ['https://evil.com/docs/csp.md', 'https://github.com/a'],
    ['см. github.com.', 'https://github.com/a'],
    ['мойсайт.рф', 'https://xn--80arbjktj.xn--p1ai/'],
    ['e\u00ADxample.com', 'https://xample.com/'],
    ['ExampIe.com', 'https://exampie.com/'],
    ['example.com/@example.org', 'https://example.org/'],
  ]

  it('правило страницы совпадает с ботом на каждом случае', async () => {
    const { linkHostNote } = pure()
    // @ts-expect-error — модуль бота на чистом JS (infra/owner-queue-bot), типов у него нет
    const bot = await import('../../owner-queue-bot/tg-html.mjs')
    for (const [label, href] of CASES) expect(linkHostNote(label, href), `${label} → ${href}`).toBe(bot.linkHostNote(label, new URL(href)))
  })

  // Один источник правила (ревью «Контроля» #327): регулярки и списки зон страницы и бота равны точно, а ответы
  // совпадают на всех сочетаниях подписей и адресов ниже — не на выборке.
  it('регулярки и списки страницы равны боту точно; ответы совпадают на всех сочетаниях', async () => {
    const a = html.indexOf('/* oq-pure:start')
    const ctx: Record<string, unknown> = createContext({ URL })
    runInContext(html.slice(a, html.indexOf('/* oq-pure:end */')), ctx)
    // @ts-expect-error — модуль бота на чистом JS (infra/owner-queue-bot), типов у него нет
    const bot = await import('../../owner-queue-bot/tg-html.mjs')
    for (const name of ['INVISIBLE_RE', 'LINK_MARK_RE', 'LINK_WORD_SPLIT_RE', 'LINK_BARE_HOST_RE']) {
      const page = ctx[name] as RegExp
      expect([page.source, page.flags], name).toEqual([bot[name].source, bot[name].flags])
    }
    for (const name of ['LINK_WEB_TLDS', 'LINK_IDN_TLDS']) {
      expect(JSON.parse(JSON.stringify(ctx[name])), name).toEqual(bot[name])
    }
    const labels = ['github.com', 'gіthub.com', 'gíthub.com', 'GitHub.COM', 'https://github.com/a', 'github.com/login?next=evil.com',
      '#evil.com', 'evil.com', 'mysite.shop', 'notion.so', '192.168.0.1', 'https://192.168.0.1:8443/x', 'г.Минск', 'И.В.Смирнов',
      'мойсайт.рф', 'docs/ops/csp.md', 'README.md', 'deploy.sh', 'версия 1.2.3', 'github.com или gitlab.com',
      'https://github.com@evil.com', 'Инцидент #5', '',
      // Ревью «Контроля» #327, раунд 2: невидимые, регистр, свой хост в пути и userinfo, имена, двойники, NFKC.
      'e\u00ADxample.com', 'e\u034Fxample.com', 'e\u200Bxample.com', 'e⟦U+00AD⟧xample.com', 'ExampIe.com', 'example.com/@example.org',
      'example.com@example.org', 'example.com/.example.org', 'г.Москва', 'ASP.NET', 'Socket.IO', 'Dockerfile.dev', 'ivan@mail.ru',
      'example.so', 'github.сом', 'ſacebook.com', 'ｇｉｔｈｕｂ.ｃｏｍ', 'www.github.com', 'https://GitHub.com/a', 'github.com — вход',
      'github.com/a', 'https://github.com', ' github.com ']
    const hrefs = ['https://github.com/a', 'https://www.github.com/', 'https://ithub.com/', 'https://xn--gthub-zsa.com/',
      'https://xn--gthub-n2e.com/', 'https://evil.com/', 'https://mysite.shop/', 'https://notion.so/x', 'https://192.168.0.1:8443/x',
      'https://xn--80arbjktj.xn--p1ai/', 'https://github.com@evil.com/', 'https://xample.com/', 'https://exampie.com/',
      'https://example.org/', 'https://example.so.example.org/', 'https://sacebook.com/', 'https://github.com/', 'https://example.com/']
    const note = ctx.linkHostNote as (label: string, href: string) => string
    let n = 0
    for (const label of labels) for (const href of hrefs) {
      expect(note(label, href), `${label} → ${href}`).toBe(bot.linkHostNote(label, new URL(href)))
      n += 1
    }
    expect(n).toBe(labels.length * hrefs.length)
  })

  it('«github.com» на чужой хост — предупреждение с настоящим хостом; подпись без доменов — хост рядом', () => {
    const { linkHostNote } = pure()
    expect(linkHostNote('github.com', 'https://ithub.com/x')).toBe(' (⚠️ ведёт на ithub.com)')
    expect(linkHostNote('Инцидент #5', 'https://ops.example/i/5')).toBe(' (ops.example)')
    expect(linkHostNote('github.com/a', 'https://github.com/a')).toBe('')
    // IDN-двойник со своим хостом — punycode виден; запрос и якорь в подписи — не адрес.
    expect(linkHostNote('gіthub.com', 'https://xn--gthub-n2e.com/')).toBe(' (xn--gthub-n2e.com)')
    expect(linkHostNote('#evil.com', 'https://github.com/a')).toBe(' (github.com)')
    // Без пометки — только буква в букву (ревью «Контроля» #327, раунд 2): путь после своего хоста и регистр — «(хост)».
    expect(linkHostNote('github.com/login?next=evil.com', 'https://github.com/a')).toBe(' (github.com)')
    expect(linkHostNote('GitHub.COM', 'https://github.com/x')).toBe(' (github.com)')
    // Невидимые на странице раньше не обрабатывались вовсе: теперь метками, а пометка — с «⚠️».
    expect(linkHostNote('e\u200Bxample.com', 'https://xample.com/')).toBe(' (⚠️ ведёт на xample.com)')
    expect(pure().revealInvisible('e\u00ADx\u200By⚠️')).toBe('e⟦U+00AD⟧x⟦U+200B⟧y⚠️')
    expect(html).toContain('var text = revealInvisible(')
    // Ссылку рисует safeLink: пометка — отдельным элементом link-host (его бот пропускает и считает сам).
    expect(html).toContain('var note = linkHostNote(text, l.href);')
    expect(html).toContain("'<span class=\"link-host'")
  })
})

describe('подсказка графиков: строки не слипаются (400dd…17f2)', () => {
  it('первая строка — жирным, остальные — через <br>, текст экранирован', () => {
    const { tipHtml } = pure()
    expect(tipHtml('не готово\nпозже на 9 дн.')).toBe('<b>не готово</b><br>позже на 9 дн.')
    expect(tipHtml('<i>x</i>\n"a" & b')).toBe('<b>&lt;i&gt;x&lt;/i&gt;</b><br>&quot;a&quot; &amp; b')
    expect(tipHtml('одна строка')).toBe('<b>одна строка</b>')
  })
})

describe('роадмап по неделям: подписи не налезают (400dd…fead)', () => {
  it('недели подписываются, только когда на неделю хватает места подписи; иначе — месяцы', () => {
    const { roadmapLabelMode } = pure()
    expect(roadmapLabelMode(84)).toBe('weeks')
    expect(roadmapLabelMode(83.9)).toBe('months')
    // горизонт прода 21.10: ~38 недель на полосе ~1200 px — по 31 px на неделю
    expect(roadmapLabelMode((1200 * 7) / 266)).toBe('months')
  })

  it('месяц — коротко, год — у первой подписи и у января', () => {
    const { roadmapMonthLabel } = pure()
    expect(roadmapMonthLabel(new Date(2026, 10, 1), false)).toBe('ноя')
    expect(roadmapMonthLabel(new Date(2026, 9, 5), true)).toBe('окт 2026')
    expect(roadmapMonthLabel(new Date(2027, 0, 1), false)).toBe('янв 2027')
  })

  it('подписи вех на одном уровне не пересекаются; важные ставятся первыми, лишние — без подписи', () => {
    const { placeRoadmapLabels } = pure()
    // три вехи в 40 px друг от друга: сделанная, впереди, просроченная — места два (над и под)
    const items = [{ x: 400, prio: 2 }, { x: 440, prio: 1 }, { x: 480, prio: 0 }]
    expect(placeRoadmapLabels(items, 1200, 112, 8)).toEqual([null, 'dn', 'up'])
    // разнесённые — все над вехами
    expect(placeRoadmapLabels([{ x: 100, prio: 1 }, { x: 300, prio: 1 }, { x: 500, prio: 1 }], 1200, 112, 8)).toEqual(['up', 'up', 'up'])
  })

  it('у края полосы подпись прижата внутрь и считается там же: две вехи у левого края — разные уровни', () => {
    const { placeRoadmapLabels } = pure()
    // x = 5 и x = 60 после прижатия — 56 и 60: на одном уровне налезли бы
    expect(placeRoadmapLabels([{ x: 5, prio: 1 }, { x: 60, prio: 1 }], 1200, 112, 8)).toEqual(['up', 'dn'])
  })

  it('на каждом уровне расстояние между центрами подписей — не меньше ширины подписи с зазором', () => {
    const { placeRoadmapLabels } = pure()
    const items = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 1100, prio: i % 3 }))
    const levels = placeRoadmapLabels(items, 1100, 112, 8)
    for (const lv of ['up', 'dn'] as const) {
      const xs = items.map((it, i) => (levels[i] === lv ? Math.min(Math.max(it.x, 56), 1100 - 56) : null)).filter((x): x is number => x !== null).sort((a, b) => a - b)
      let prev: number | null = null
      for (const x of xs) {
        if (prev !== null) expect(x - prev).toBeGreaterThanOrEqual(120)
        prev = x
      }
    }
  })
})

describe('переход к пункту по ссылке «#item=<id>» (колонка «Связь» на /deploys)', () => {
  it('id из хэша — только по шаблону id документа: кавычки и скобки не попадут в селектор', () => {
    const { targetFromHash } = pure()
    expect(targetFromHash('#item=c-404-login')).toBe('c-404-login')
    expect(targetFromHash(`#item=${encodeURIComponent('m-1:a@b+c')}`)).toBe('m-1:a@b+c')
    expect(targetFromHash('#item=a"]>b')).toBe('')
    expect(targetFromHash('#item=%E0%A4%A')).toBe('')
    expect(targetFromHash('#sec-merge')).toBe('')
    expect(targetFromHash('')).toBe('')
  })

  it('выполненный пункт-цель виден и раскрыт даже при «Скрыть выполненные»', () => {
    expect(html).toMatch(/body\.hide-done \.item\.is-target\.is-done \{ display: grid; \}/)
    expect(html).toMatch(/\.item\.is-target\.is-done \.item-body \{ display: grid; \}/)
  })
})

describe('шапка, Гант и справка (просьба владельца 10.11)', () => {
  const phone = (() => {
    const at = html.indexOf('@media (max-width: 640px) {')
    return html.slice(at, html.indexOf('\n}\n', at))
  })()

  it('телефон: шапка в одну строку, у кнопок значки, выбор продукта не раздвигает страницу', () => {
    expect(phone).toMatch(/\.head-bar, \.hb-nav \{ flex-wrap: nowrap;/)
    expect(phone).toContain('.hb-ico { display: block; }')
    expect(phone).toMatch(/\.hb-long, #jump-dash \{ display: none; \}/)
    expect(phone).toMatch(/#head-bar \.oq-product-pick \{[^}]*width: 0;[^}]*min-width: 0;/)
    expect(html).not.toContain('hb-short')
  })

  it('кнопки-значки названы для экранного чтения и подсказкой', () => {
    const bar = html.slice(html.indexOf('<div class="head-bar" id="head-bar">'), html.indexOf('<!-- Форма «Поставить задачу»'))
    expect(bar).toMatch(/id="compose-open"[^>]*aria-label="Поставить задачу" title="Поставить задачу"/)
    expect(bar).toMatch(/<summary class="hb-btn" aria-label="Очередь: разделы" title="[^"]+">/)
    expect(bar).toMatch(/id="reports-open"[^>]*aria-label="Отчёты" title="[^"]+">/)
    // Значки — украшение: экранный диктор читает подпись кнопки, а не svg.
    expect(bar).toMatch(/id="layout-btn" aria-label="Одной очередью" title="[^"]+">/)
    expect(bar.match(/<svg class="hb-ico"[^>]*aria-hidden="true"/g)?.length).toBe(3)
  })

  it('Гант: строка шириной со шкалу — липкое название не уезжает при прокрутке вбок', () => {
    expect(html).toMatch(/\.g-row \{ display: flex; width: max-content; min-width: 100%;/)
    expect(html).toMatch(/\.g-label \{ position: sticky; left: 0;/)
  })

  it('«Как пользоваться» описывает каждый раздел, отчёт и элемент шапки', () => {
    const howto = html.slice(html.indexOf('<details class="howto-d" id="howto-d"'), html.indexOf('</details>', html.indexOf('id="howto-d"')))
    for (const w of ['Решения', 'Мёржи', '«Влить»', '«Перезапустить деплой»', 'Команды на сервере', 'Проверить руками', 'Входящие',
      '«📎 Добавить файл»', 'Продукт у пункта', '«Изменить ответ»', '«Ждёт вас снова»', '«Показать выполненные»', '#item=',
      'выбор продукта', '«＋ Поставить задачу»', '«Очередь»', '«Одной очередью»', '«По разделам»', 'от старых к новым', '«Ход работ»', '«К решениям ↓»', 'тема', 'Шапка на телефоне',
      'Ваша очередь по дням', 'правая ось', 'прогноз на 30 дней', 'план и факт', 'Готовность по разделам', 'Карточки t-boards в плане',
      'Отставание от плана', 'Сколько PR ждали мёржа', '36 часов', 'Диаграмма Ганта', 'Роадмап', 'Отчёт по задачам']) {
      expect(howto.toLowerCase()).toContain(w.toLowerCase())
    }
  })

  it('«Ход работ»: подпись продукта у карточек и разбивка при «Все продукты»; PR — только репозиторий HR', () => {
    expect(html).toContain('<p class="sec-note" id="dash-split" hidden></p>')
    expect(html).toContain("try { paintScope(ws); } catch (e)")
    expect(html).toMatch(/var HR_ONLY = \{ 'card-pr': 1 \};/)
  })
})

describe('порядок пунктов: от старых к новым (просьба владельца 13.11)', () => {
  const ids = (list: OrderIt[]) => list.map((it) => it.id)

  it('по added по возрастанию; без даты — первым (вшитые пункты 15–16.10 старше всех)', () => {
    const { orderItems } = pure()
    const list = [
      { id: 'd-c', added: '2026-11-13', updatedAt: 1 },
      { id: 'd-a', added: '2026-10-20', updatedAt: 9 },
      { id: 'd-seed' },
      { id: 'd-b', added: '2026-11-01', updatedAt: 5 },
    ]
    expect(ids(orderItems(list, null))).toEqual(['d-seed', 'd-a', 'd-b', 'd-c'])
    // Исходный массив не меняется: страница сортирует копию.
    expect(ids(list)).toEqual(['d-c', 'd-a', 'd-seed', 'd-b'])
  })

  it('при равной дате — по updatedAt строки снимка, затем по id', () => {
    const { orderItems } = pure()
    const list = [
      { id: 'm-3', added: '2026-11-13', updatedAt: 3000 },
      { id: 'm-2', added: '2026-11-13', updatedAt: 1000 },
      { id: 'm-b', added: '2026-11-13', updatedAt: 2000 },
      { id: 'm-a', added: '2026-11-13', updatedAt: 2000 },
      { id: 'm-0', added: '2026-11-13' },
    ]
    expect(ids(orderItems(list, null))).toEqual(['m-0', 'm-2', 'm-a', 'm-b', 'm-3'])
  })

  it('«одной очередью»: открытые и «ждёт вас снова» — раньше выполненных, в каждой группе — от старых к новым', () => {
    const { orderItems, isDone } = pure()
    const state: Record<string, Record<string, unknown>> = {
      'c-old-done': { done: true, at: '2026-11-02T10:00:00.000Z' },
      'd-new-done': { done: true, choice: 'yes', at: '2026-11-13T10:00:00.000Z' },
      // Ответил, а агент после ответа снова ждёт — открыт.
      's-again': { done: true, at: '2026-11-10T10:00:00.000Z', agentStatus: 'blocked', agentAt: '2026-11-11T10:00:00.000Z' },
    }
    const list = [
      { id: 'd-new-done', kind: 'decision', added: '2026-11-13', updatedAt: 1 },
      { id: 'm-new', kind: 'merge', added: '2026-11-12', updatedAt: 1 },
      { id: 'c-old-done', kind: 'check', added: '2026-11-01', updatedAt: 1 },
      { id: 's-again', kind: 'server', added: '2026-11-10', updatedAt: 1 },
      { id: 'd-old', kind: 'decision', added: '2026-11-05', updatedAt: 1 },
    ]
    const done = (it: OrderIt) => isDone({ kind: it.kind! }, state[it.id])
    expect(ids(orderItems(list, done))).toEqual(['d-old', 's-again', 'm-new', 'c-old-done', 'd-new-done'])
    // По разделам выполненные не уходят вниз: порядок — только по дате.
    expect(ids(orderItems(list, null))).toEqual(['c-old-done', 'd-old', 's-again', 'm-new', 'd-new-done'])
  })

  it('страница ставит пункты по этому порядку, а снимок несёт updatedAt строки', () => {
    expect(html).toContain('var els = orderItems(')
    expect(html).toContain("updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0")
    expect(html).toContain('list.forEach(function (it) { it.updatedAt = at[it.id]; });')
    // Пункты базы больше не встают в начало списка в порядке сервера (новые сверху).
    expect(html).not.toContain("'afterbegin' : 'beforeend'")
    expect(html).not.toContain('list.slice().reverse().forEach')
  })

  // applyItems со страницы — в vm с заглушками DOM: ключ снимка без updatedAt (замечание Контроля к #154).
  // itemFromDb — настоящая, со страницы: в ключ снимка идёт ровно то, что она кладёт в пункт.
  const applyItemsRun = () => {
    const mounted: { id: string; title?: string; updatedAt?: number }[] = []
    const ctx = createContext({
      LIVE: {}, ITEMS: [], DB_ITEMS: [], dbItemsKey: '', FILES: null,
      LABELS: { merge: 'Мёрж' }, INBOX_TYPE: {}, INBOX_URGENCY: {}, INBOX_SEVERITY: {},
      textToHtml: (t: unknown) => (typeof t === 'string' ? t : ''), safeLink: () => '',
      rowsOf: (snap: unknown) => snap,
      otherProduct: () => false,
      document: { querySelectorAll: () => [] },
      // живая ссылка: видно, какой updatedAt у пункта на странице после каждого снимка
      mount: (it: { id: string; updatedAt?: number }) => mounted.push(it),
      render: () => {}, showTarget: () => {},
    })
    runInContext(fnSource('itemFromDb'), ctx)
    runInContext(fnSource('applyItems'), ctx)
    return { apply: (rows: unknown) => runInContext('applyItems', ctx)(rows), mounted }
  }

  it('запись агента в невидимое поле (sha) не пересоздаёт пункты; порядок держит updatedAt последнего пересоздания', () => {
    const { apply, mounted } = applyItemsRun()
    const row = (data: Record<string, unknown>, updatedAt: number) => [{ id: 'm-1', data: { kind: 'merge', added: '2026-11-13', ...data }, updatedAt }]
    apply(row({ title: 'A' }, 100))
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ id: 'm-1', title: 'A', updatedAt: 100 })
    apply(row({ title: 'A', sha: 'abc', pr: 154 }, 200))
    expect(mounted).toHaveLength(1)
    // Пункты не переставляются от невидимой записи: updatedAt — снимка, после которого пункт пересоздан.
    expect(mounted[0]?.updatedAt).toBe(100)
    // Видимое поле изменилось — пункты пересоздаются, порядок берёт свежий updatedAt.
    apply(row({ title: 'B', sha: 'abc' }, 300))
    expect(mounted).toHaveLength(2)
    expect(mounted[1]).toMatchObject({ id: 'm-1', title: 'B', updatedAt: 300 })
  })
})

// Текст функции страницы по имени: от «function <имя>(» до закрывающей скобки на том же отступе.
function fnSource(name: string): string {
  const start = html.indexOf('  function ' + name + '(')
  if (start < 0) throw new Error('нет функции ' + name)
  const end = html.indexOf('\n  }\n', start)
  if (end < 0) throw new Error('не найден конец функции ' + name)
  return html.slice(start, end + 4)
}

describe('раскладка «Одной очередью» / «По разделам» (просьба владельца 13.11)', () => {
  const phone = (() => {
    const at = html.indexOf('@media (max-width: 640px) {')
    return html.slice(at, html.indexOf('\n}\n', at))
  })()

  it('одной очередью — решения, мёржи, сервер и проверки в общем списке; входящие — в своём разделе', () => {
    const { listOfKind } = pure()
    expect(['decision', 'merge', 'server', 'check', 'inbox'].map((k) => listOfKind(k, 'one'))).toEqual(['queue', 'queue', 'queue', 'queue', 'inbox'])
    expect(['decision', 'merge', 'server', 'check', 'inbox'].map((k) => listOfKind(k, 'sections'))).toEqual(['decision', 'merge', 'server', 'check', 'inbox'])
  })

  it('сохранённый выбор: только «one» — одной очередью; пусто, мусор и прочее — по разделам (по умолчанию)', () => {
    const { layoutOf } = pure()
    expect(layoutOf('one')).toBe('one')
    for (const v of [null, '', 'sections', 'ONE', 'queue', undefined]) expect(layoutOf(v)).toBe('sections')
  })

  it('выбор — localStorage oq-queue-layout, чтение и запись — в try/catch', () => {
    expect(html).toContain("var LAYOUT_KEY = 'oq-queue-layout', LAYOUT = 'sections';")
    expect(html).toContain("try { LAYOUT = layoutOf(localStorage.getItem(LAYOUT_KEY)); } catch (e) { LAYOUT = 'sections'; }")
    expect(html).toContain('try { localStorage.setItem(LAYOUT_KEY, LAYOUT); } catch (e) {')
  })

  it('общий список — с заголовком, скрыт по умолчанию и без data-section: бот собирает разделы по нему', () => {
    expect(html).toMatch(/<section id="sec-queue" hidden>\s*<div class="sec-head"><h2 class="sec">Очередь — по порядку выполнения<\/h2><span class="sec-count" data-count><\/span><\/div>/)
    expect(html).not.toMatch(/data-section="queue"/)
    // Расстановка: в общем списке выполненные — после открытых; в разделах — только по дате.
    expect(html).toContain("var els = orderItems(groups[key], key === 'queue' ? doneOf : null)")
    expect(html).toContain('var key = listOfKind(it.kind, LAYOUT);')
    // Число общего списка — сумма четырёх разделов.
    expect(html).toContain("if (qc) qc.textContent = queueReady() ? qk + ' из ' + qn : '…';")
  })

  it('метка вида — у четырёх видов, вне строки чипов (её читает бот), видна только в общем списке', () => {
    expect(html).toContain("var KIND_NAME = { decision: 'Решение', merge: 'Мёрж', server: 'На сервере', check: 'Проверить руками' };")
    expect(html).toContain(`'" data-kind="' + esc(it.kind) + '"><div class="item-head">' + kindHtml + '<h3 class="item-title">'`)
    expect(html).toContain('.item-kind { display: none; }')
    expect(html).toMatch(/#sec-queue \.item-kind \{ display: inline-block;/)
  })

  it('переходы «Очередь → вид» одной очередью ведут к пункту в общем списке, «К решениям ↓» — к общему списку', () => {
    expect(html).toContain("if (a.dataset.kind && listOfKind(a.dataset.kind, LAYOUT) === 'queue') { ev.preventDefault(); jumpToKind(a.dataset.kind); return; }")
    expect(html).toContain("toDec.setAttribute('href', one ? '#sec-queue' : '#sec-decision')")
  })

  it('инструкция ssh: одной очередью — в конце общего списка (раздел «На сервере» скрыт), по разделам — на месте', () => {
    // В разметке инструкция — в разделе сервера, перед списком; ссылка «как подключиться» ведёт на неё.
    expect(html).toMatch(/<section data-section="server" id="sec-server">[\s\S]*?<div class="howto" id="ssh-howto">[\s\S]*?<div class="list"><\/div>\s*<\/section>/)
    expect(html).toContain('<a href="#ssh-howto">как подключиться</a>')
    expect(fnSource('paintLayout')).toContain('placeSshHowto(one);')
    const calls: string[] = []
    const howto = { id: 'ssh-howto' }
    const sec = (id: string) => ({
      appendChild: (n: { id: string }) => calls.push(`${id}.append(${n.id})`),
      insertBefore: (n: { id: string }, ref: { id: string }) => calls.push(`${id}.insertBefore(${n.id}, ${ref.id})`),
      querySelector: (sel: string) => (sel === '.list' ? { id: `${id} .list` } : null),
    })
    const ctx = createContext({ sshHowto: howto, document: { getElementById: (id: string) => sec(id) } })
    runInContext(fnSource('placeSshHowto'), ctx)
    const place = runInContext('placeSshHowto', ctx)
    place(true)
    place(false)
    expect(calls).toEqual(['sec-queue.append(ssh-howto)', 'sec-server.insertBefore(ssh-howto, sec-server .list)'])
    // Нет узла инструкции или раздела — без исключения: переключатель раскладки не ломается.
    for (const env of [{ sshHowto: null, document: { getElementById: sec } }, { sshHowto: howto, document: { getElementById: () => null } }]) {
      const bare = createContext(env)
      runInContext(fnSource('placeSshHowto'), bare)
      expect(() => runInContext('placeSshHowto', bare)(true)).not.toThrow()
      expect(() => runInContext('placeSshHowto', bare)(false)).not.toThrow()
    }
    expect(calls).toHaveLength(2)
  })

  it('телефон: кнопка — значок 40 px (касание не меньше 36 px), шапка не раздвигается', () => {
    expect(phone).toMatch(/\.hb-compose, \.hb-reports, \.hb-theme, \.hb-layout \{ flex: none; width: 40px;/)
    expect(html).toMatch(/\.hb-btn \{[^}]*min-height: 40px;/)
  })

  it('подпись продукта и отбор по продукту — и у пунктов общего списка', () => {
    expect(PRODUCTS_JS).toContain("document.querySelectorAll('section[data-section] .item[data-id], #sec-queue .item[data-id]').forEach(decorateItem);")
    expect(PRODUCTS_JS).toContain("document.querySelectorAll('section[data-section] .list, #sec-queue .list')")
  })
})
