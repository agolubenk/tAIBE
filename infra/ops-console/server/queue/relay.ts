/**
 * Автопередача входящих сессии (входящее владельца 9654). Сессия, которая ведёт входящие, держит Monitor на
 * `node infra/owner-queue-mcp/server.mjs --relay <имя сессии>`: процесс раз в 20 с смотрит очередь, печатает
 * «Возьми входящее <id>» про каждое новое входящее (Monitor будит этим сессию) и раз в минуту отмечается здесь.
 * Страница /queue и бот по отметке честно говорят, уходят ли входящие сессии сами: три минуты без отметки — процесса
 * нет (сессия закрыта или Monitor истёк и не перевзведён), «Возьми входящее» владелец вставляет руками.
 *
 * Хранится одной настройкой (не документом очереди): отметка раз в минуту не меняет ETag коллекций, которые страница
 * опрашивает каждые 4 с, и не пишет журнал oq_events.
 */
import { z } from 'zod'
import { readSetting, writeSetting } from '../settings/store'
import { DOC_ID, SESSION_MAX } from './store'

const KEY = 'oq-relay'
/** Отметка — раз в минуту; три пропуска подряд — автопередачи нет. */
export const RELAY_STALE_MS = 3 * 60_000
const FORGET_MS = 24 * 3600_000
const MAX_SESSIONS = 5
const MAX_RELAYED = 100

const storedSchema = z.object({
  sessions: z.record(z.object({ at: z.string(), relayed: z.record(z.string()).default({}) })).default({}),
})
export const relayBeatSchema = z.object({
  session: z
    .string()
    .max(SESSION_MAX)
    .regex(/^[A-Za-z0-9._-]+$/, 'session — имя сессии: латиница, цифры, «.», «_», «-»')
    // Имя — ключ объекта настройки: служебные имена объекта не берём (ревью #324, п. 7).
    .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s), 'служебное имя не подходит'),
  // id пункта как ключ объекта: служебные имена объекта не берём.
  relayed: z.array(z.string().regex(DOC_ID).refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))).max(50).default([]),
})
export type RelayBeat = z.infer<typeof relayBeatSchema>

export interface RelayView {
  /** Хоть одна сессия отмечалась за RELAY_STALE_MS. */
  alive: boolean
  sessions: { session: string; at: string; alive: boolean }[]
  /** Кому и когда передано входящее (по id пункта) — первая передача. */
  relayed: Record<string, { session: string; at: string }>
}

function view(stored: z.infer<typeof storedSchema>, now: number): RelayView {
  const sessions = Object.entries(stored.sessions)
    .map(([session, v]) => ({ session, at: v.at, alive: now - Date.parse(v.at) < RELAY_STALE_MS }))
    .sort((a, b) => b.at.localeCompare(a.at))
  const relayed: RelayView['relayed'] = {}
  for (const [session, v] of Object.entries(stored.sessions)) {
    for (const [id, at] of Object.entries(v.relayed)) if (!relayed[id] || relayed[id].at > at) relayed[id] = { session, at }
  }
  return { alive: sessions.some((s) => s.alive), sessions, relayed }
}

export async function readRelay(now = Date.now()): Promise<RelayView> {
  return view(await readSetting(KEY, storedSchema), now)
}

/**
 * Отметки по очереди: чтение и запись настройки — два шага, и две сессии с --relay одновременно теряли бы чужую отметку
 * (ревью «Контроля» #324, п. 3). Консоль — один процесс, поэтому достаточно цепочки промисов.
 */
let beatChain: Promise<unknown> = Promise.resolve()

/** Отметка процесса автопередачи: время — серверное, переданные id копятся (последние MAX_RELAYED на сессию). */
export function beatRelay(beat: RelayBeat, now = new Date()): Promise<RelayView> {
  const run = beatChain.then(() => applyBeat(beat, now))
  beatChain = run.catch(() => undefined)
  return run
}

async function applyBeat(beat: RelayBeat, now: Date): Promise<RelayView> {
  const stored = await readSetting(KEY, storedSchema)
  const at = now.toISOString()
  const relayed = { ...(stored.sessions[beat.session]?.relayed ?? {}) }
  for (const id of beat.relayed) relayed[id] ??= at
  const sessions = { ...stored.sessions, [beat.session]: { at, relayed: Object.fromEntries(Object.entries(relayed).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_RELAYED)) } }
  // Сессии без отметки сутки забываются; одновременно — не больше пяти.
  const kept = Object.entries(sessions)
    .filter(([, v]) => now.getTime() - Date.parse(v.at) < FORGET_MS)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, MAX_SESSIONS)
  const next = { sessions: Object.fromEntries(kept) }
  await writeSetting(KEY, next)
  return view(next, now.getTime())
}
