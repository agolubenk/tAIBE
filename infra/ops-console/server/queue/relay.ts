/**
 * Автопередача входящих сессии (входящее владельца 9654). Сессия, которая ведёт входящие, держит Monitor на
 * `node infra/owner-queue-mcp/server.mjs --relay <имя сессии>`: процесс раз в 20 с смотрит очередь, печатает
 * «Возьми входящее <id>» про каждое новое входящее (Monitor будит этим сессию) и раз в минуту отмечается здесь.
 * Страница /queue и бот по отметке честно говорят, уходят ли входящие сессии сами: три минуты без отметки — процесса
 * нет (сессия закрыта или Monitor истёк и не перевзведён), «Возьми входящее» владелец вставляет руками.
 *
 * По продуктам (фаза 4a, OPS-51): отметка несёт продукт сессии, у каждого продукта своя живость. Актор видит только
 * сессии своих продуктов — токен taibe не узнаёт ни сессий HR, ни id их входящих, и наоборот. Отметка без продукта
 * (процесс прежней версии) — продукт по умолчанию.
 *
 * Хранится одной настройкой (не документом очереди): отметка раз в минуту не меняет ETag коллекций, которые страница
 * опрашивает каждые 4 с, и не пишет журнал oq_events.
 */
import { z } from 'zod'
import { readSetting, writeSetting } from '../settings/store'
import { canSee, DEFAULT_PRODUCT, PRODUCT_SLUG, type Visibility } from './products'
import { DOC_ID, SESSION_MAX } from './store'

const KEY = 'oq-relay'
/** Отметка — раз в минуту; три пропуска подряд — автопередачи нет. */
export const RELAY_STALE_MS = 3 * 60_000
const FORGET_MS = 24 * 3600_000
/** Сессий автопередачи на продукт одновременно. */
const MAX_SESSIONS = 5
const MAX_RELAYED = 100

const storedSchema = z.object({
  sessions: z
    .record(z.object({ at: z.string(), relayed: z.record(z.string()).default({}), product: z.string().default(DEFAULT_PRODUCT) }))
    .default({}),
})
type Stored = z.infer<typeof storedSchema>

export const relayBeatSchema = z.object({
  session: z
    .string()
    .max(SESSION_MAX)
    .regex(/^[A-Za-z0-9._-]+$/, 'session — имя сессии: латиница, цифры, «.», «_», «-»')
    // Имя — ключ объекта настройки: служебные имена объекта не берём (ревью #324, п. 7).
    .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s), 'служебное имя не подходит'),
  // id пункта как ключ объекта: служебные имена объекта не берём.
  relayed: z.array(z.string().regex(DOC_ID).refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))).max(50).default([]),
  /** Продукт, входящие которого передаёт сессия; без него — единственный или основной продукт токена. */
  product: z.string().regex(PRODUCT_SLUG, 'product — slug продукта').optional(),
})
export type RelayBeat = z.infer<typeof relayBeatSchema>

export interface RelaySession {
  session: string
  at: string
  alive: boolean
  product: string
}

export interface RelayView {
  /** Хоть одна видимая актору сессия отмечалась за RELAY_STALE_MS. */
  alive: boolean
  sessions: RelaySession[]
  /** Кому и когда передано входящее (по id пункта) — первая передача. */
  relayed: Record<string, { session: string; at: string }>
  /** По продукту: последняя отметившаяся сессия и жива ли автопередача продукта (хоть одна сессия жива). */
  products: Record<string, { alive: boolean; session: string; at: string }>
}

/**
 * Продукт отметки: явный — если актор его видит; без явного — основной продукт, если актор его видит, иначе
 * единственный продукт токена. null — не определить (токен нескольких продуктов без основного) или продукт чужой.
 */
export function beatProduct(products: Visibility, asked: string | undefined): string | null {
  if (asked) return canSee(products, asked) ? asked : null
  if (canSee(products, DEFAULT_PRODUCT)) return DEFAULT_PRODUCT
  return products !== '*' && products.length === 1 ? products[0]! : null
}

function view(stored: Stored, now: number, visible: Visibility): RelayView {
  const own = Object.entries(stored.sessions).filter(([, v]) => canSee(visible, v.product))
  const sessions = own
    .map(([session, v]) => ({ session, at: v.at, alive: now - Date.parse(v.at) < RELAY_STALE_MS, product: v.product }))
    .sort((a, b) => b.at.localeCompare(a.at))
  const relayed: RelayView['relayed'] = {}
  for (const [session, v] of own) {
    for (const [id, at] of Object.entries(v.relayed)) if (!relayed[id] || relayed[id].at > at) relayed[id] = { session, at }
  }
  // Сессии уже по убыванию времени: первая живая продукта, а без живых — последняя отметившаяся.
  const products: RelayView['products'] = {}
  for (const s of sessions) {
    const cur = products[s.product]
    if (!cur || (s.alive && !cur.alive)) products[s.product] = { alive: s.alive, session: s.session, at: s.at }
  }
  return { alive: sessions.some((s) => s.alive), sessions, relayed, products }
}

export async function readRelay(visible: Visibility, now = Date.now()): Promise<RelayView> {
  return view(await readSetting(KEY, storedSchema), now, visible)
}

/**
 * Отметки по очереди: чтение и запись настройки — два шага, и две сессии с --relay одновременно теряли бы чужую отметку
 * (ревью «Контроля» #324, п. 3). Консоль — один процесс, поэтому достаточно цепочки промисов.
 */
let beatChain: Promise<unknown> = Promise.resolve()

/**
 * Отметка процесса автопередачи: время — серверное, переданные id копятся (последние MAX_RELAYED на сессию). product —
 * уже проверенный beatProduct; ответ — то, что видит отметившийся актор.
 */
export function beatRelay(beat: RelayBeat, product: string, visible: Visibility, now = new Date()): Promise<RelayView> {
  const run = beatChain.then(() => applyBeat(beat, product, visible, now))
  beatChain = run.catch(() => undefined)
  return run
}

async function applyBeat(beat: RelayBeat, product: string, visible: Visibility, now: Date): Promise<RelayView> {
  const stored = await readSetting(KEY, storedSchema)
  const at = now.toISOString()
  const prev = stored.sessions[beat.session]
  // Сессия сменила продукт — прежние передачи относятся к чужому продукту: их не переносим.
  const relayed = { ...(prev && prev.product === product ? prev.relayed : {}) }
  for (const id of beat.relayed) relayed[id] ??= at
  const sessions = {
    ...stored.sessions,
    [beat.session]: { at, product, relayed: Object.fromEntries(Object.entries(relayed).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_RELAYED)) },
  }
  // Сессии без отметки сутки забываются; одновременно — не больше MAX_SESSIONS на продукт.
  const perProduct: Record<string, number> = {}
  const kept = Object.entries(sessions)
    .filter(([, v]) => now.getTime() - Date.parse(v.at) < FORGET_MS)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .filter(([, v]) => (perProduct[v.product] = (perProduct[v.product] ?? 0) + 1) <= MAX_SESSIONS)
  const next = { sessions: Object.fromEntries(kept) }
  await writeSetting(KEY, next)
  return view(next, now.getTime(), visible)
}
