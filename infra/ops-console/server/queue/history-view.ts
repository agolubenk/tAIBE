/**
 * Ответ GET /history/:col/:id для агентов (MCP oq_history; карточка HR oow56fdzk). Каждое событие несёт after — полный
 * снимок документа (body до 12 000 символов, note до 20 000), и 50 событий давали до ~2,5 МБ на вызов.
 * - `?limit=` 1–100. Без него — 50, как раньше: синхронизация досок (forest/owner-queue/sync-pass.ts) читает историю
 *   без параметров и ищет в after ответ владельца.
 * - `?before=<next>` — следующая страница: `next` прошлого ответа, номер события журнала (у одной миллисекунды
 *   может быть несколько событий, поэтому не время).
 * - `?fields=meta` — без after: at, actor, action и keys — какие поля верхнего уровня событие изменило против
 *   предыдущего; null — сравнить не с чем (after обрезан маркером или его нет).
 */
import { apiError } from '../http-types'

export const HISTORY_LIMIT_DEFAULT = 50
export const HISTORY_LIMIT_MAX = 100

export type HistoryQuery = { limit: number; before?: number; meta: boolean }
type Event = { at: number; actor: string; action: string; after: unknown }
/** Окно docHistory (store.ts): события, есть ли старше, номер последней строки окна и after следующего за окном. */
export type HistoryPage = { events: Event[]; more: boolean; nextId?: number; olderAfter?: unknown }

const intIn = (raw: string, lo: number, hi: number) => /^\d{1,15}$/.test(raw) && Number(raw) >= lo && Number(raw) <= hi

export function historyQuery(q: { limit?: string; before?: string; fields?: string }): HistoryQuery {
  if (q.limit !== undefined && !intIn(q.limit, 1, HISTORY_LIMIT_MAX)) throw apiError(400, `limit — целое от 1 до ${HISTORY_LIMIT_MAX}`)
  if (q.before !== undefined && !intIn(q.before, 1, Number.MAX_SAFE_INTEGER)) throw apiError(400, 'before — next из прошлого ответа')
  if (q.fields !== undefined && q.fields !== 'meta') throw apiError(400, 'fields — только meta')
  return {
    limit: q.limit === undefined ? HISTORY_LIMIT_DEFAULT : Number(q.limit),
    ...(q.before === undefined ? {} : { before: Number(q.before) }),
    meta: q.fields === 'meta',
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (v as { truncated?: unknown }).truncated !== true

/** Поля верхнего уровня, которые after изменил против более старого prev; null — сравнить не с чем. */
function changedKeys(after: unknown, prev: unknown): string[] | null {
  if (!isPlain(after)) return null
  if (prev === undefined) return Object.keys(after).sort()
  if (!isPlain(prev)) return null
  const keys = new Set([...Object.keys(after), ...Object.keys(prev)])
  return [...keys].filter((k) => JSON.stringify(after[k]) !== JSON.stringify(prev[k])).sort()
}

/** Тело ответа: события окна (со снимками или keys) и next, если есть старше. Самое старое событие документа — все поля. */
export function historyReplyBody(page: HistoryPage, q: HistoryQuery): { events: unknown[]; next?: string } {
  const { events: list, more, nextId, olderAfter } = page
  const events = list.map((e, i) => {
    if (!q.meta) return e
    const prev = i + 1 < list.length ? list[i + 1]!.after : more ? (olderAfter ?? null) : undefined
    return { at: e.at, actor: e.actor, action: e.action, keys: changedKeys(e.after, prev) }
  })
  return more && nextId !== undefined ? { events, next: String(nextId) } : { events }
}
