/**
 * Правило срока строки плана (work.planEnd) для записи агента — TB-112, F7.3. Вызывает writeDoc внутри своей
 * транзакции: `find` читает пункт и ответ тем же tx. Владельцу правило не применяется.
 */
import type { oqDocs } from '../db/schema'
import { apiError } from '../http-types'
import type { Collection } from './store'

type Row = typeof oqDocs.$inferSelect
type Find = (collection: Collection, id: string) => Promise<Row | undefined>

/** Вариант решения d-…-due…, который разрешает сдвиг срока (TB-112: «держать срок» keep · «перенести» move · «оставить красными» red). */
export const DUE_MOVE = 'move'
// d-<продукт>-due[-<тема>]: «due» — отдельное слово id (d-taibe-due-20261113 от плана досок, #159), не часть другого.
const DUE_REF = /^d-[A-Za-z0-9_.~:@+-]*-due(-[A-Za-z0-9_.~:@+-]*)?$/
/** Сколько ответов «перенести» помнит строка. Дальше — 409: срок строки решает владелец сам, ссылки не теряются. */
const DUE_REFS_MAX = 50

const day = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 10) : '')
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Строка `moveTo`, чьей даты нет в тексте решения: ни `YYYY-MM-DD`, ни `DD.MM`. Страница и бот `moveTo` не показывают,
 * а сервер ограничивает сдвиг именно им — значит, дата должна быть в тексте, который владелец читает (TB-112).
 */
export function moveToUnseen(moveTo: Record<string, string> | undefined, text: string): { row: string; date: string } | undefined {
  for (const [row, date] of Object.entries(moveTo ?? {})) {
    const short = new RegExp(`(?<!\\d)${date.slice(8, 10)}\\.${date.slice(5, 7)}(?!\\d)`)
    if (!text.includes(date) && !short.test(text)) return { row, date }
  }
  return undefined
}

/**
 * Срок строки плана агент не сдвигает сам (TB-112, F7.3; владелец 13.11: «сроки сдвигаются всё больше — неприемлемо»).
 * Раньше любое следующее после первого сдвига проходило молча, и 12 строк ушли на 2–4 недели без ответа владельца.
 * Позже planEnd — только по ответу владельца «перенести» (вариант `move`) в решении `d-…-due…`: строка названа в
 * `rows`, дата переноса — в `moveTo[<id строки>]`, новый planEnd не позже неё. Решение не менялось после ответа
 * (`updatedAt` пункта ≤ `ownerAt` ответа): владелец согласился на то, что видел. id решения — в `dueRef` записи, одна
 * ссылка — один сдвиг (`dueRefs`). Снять planEnd агент не может. `dueRefs` и `basePlanEnd` (первый план) ведёт сервер:
 * агент их не присылает и не стирает полной заменой. Раньше срок — без ответа. Владельцу — всё.
 */
export async function guardPlanEnd(
  rowId: string,
  before: Record<string, unknown> | null,
  merged: Record<string, unknown>,
  find: Find,
  visible: (row: Row) => boolean,
): Promise<void> {
  const dueRef = merged.dueRef
  delete merged.dueRef
  if (!before) {
    // Новая строка: ссылок ещё нет; первый план — её же срок.
    if (merged.dueRefs !== undefined) throw apiError(409, 'dueRefs ведёт сервер: у новой строки их нет')
    if (merged.basePlanEnd !== undefined && day(merged.basePlanEnd) !== day(merged.planEnd)) {
      throw apiError(409, 'basePlanEnd новой строки — её planEnd или пусто: первый план ставит сервер')
    }
    return
  }
  const sentBase = merged.basePlanEnd
  const sentRefs = merged.dueRefs
  for (const k of ['basePlanEnd', 'dueRefs'] as const) {
    if (before[k] !== undefined) merged[k] = before[k]
    else delete merged[k]
  }
  const prev = day(before.planEnd)
  const next = day(merged.planEnd)
  if (prev && !(next && next <= prev)) await allowShift(rowId, prev, next, dueRef, before, merged, find, visible)
  if (sentBase !== undefined && !sameJson(sentBase, before.basePlanEnd)) {
    throw apiError(409, `basePlanEnd — первый план строки («${String(before.basePlanEnd ?? 'нет')}»): его ставит сервер при первом сдвиге, агент не меняет`)
  }
  if (sentRefs !== undefined && !sameJson(sentRefs, before.dueRefs)) throw apiError(409, 'dueRefs ведёт сервер: ссылку на ответ передают в dueRef')
}

/** Сдвиг planEnd позже `prev` (или снятие) агентом: проверки ответа владельца; при успехе — ссылка в dueRefs. */
async function allowShift(
  rowId: string,
  prev: string,
  next: string,
  dueRef: unknown,
  before: Record<string, unknown>,
  merged: Record<string, unknown>,
  find: Find,
  visible: (row: Row) => boolean,
): Promise<void> {
  if (!next) throw apiError(409, `Снять planEnd («${prev}») может только владелец`)
  const how = `Сдвиг срока позже «${prev}» — только по ответу владельца: решение d-<продукт>-due-<тема> с rows: [«${rowId}»], moveTo: {«${rowId}»: дата} и вариантом id «${DUE_MOVE}» («перенести»); его id — в dueRef этой записи. Раньше срок — без ответа`
  if (typeof dueRef !== 'string' || !DUE_REF.test(dueRef)) throw apiError(409, `planEnd не переписывается. ${how}`)
  const item = await find('items', dueRef)
  if (!item || !visible(item)) throw apiError(409, `Нет решения items/${dueRef}. ${how}`)
  const d = JSON.parse(item.dataJson) as Record<string, unknown>
  if (!Array.isArray(d.rows) || !d.rows.includes(rowId)) throw apiError(409, `В решении ${dueRef} нет этой строки (rows). ${how}`)
  const check = await find('checks', dueRef)
  const answer = check ? (JSON.parse(check.dataJson) as Record<string, unknown>) : {}
  if (answer.choice !== DUE_MOVE) throw apiError(409, `Владелец не ответил «перенести» в ${dueRef} (ответ: ${String(answer.choice ?? 'нет')}). ${how}`)
  const ownerAt = typeof answer.ownerAt === 'string' ? Date.parse(answer.ownerAt) : NaN
  if (!Number.isFinite(ownerAt) || item.updatedAt.getTime() > ownerAt) {
    throw apiError(409, `Решение ${dueRef} изменено после ответа владельца (или ответ без отметки сервера) — нужен новый ответ на текущий текст`)
  }
  const to = d.moveTo && typeof d.moveTo === 'object' ? day((d.moveTo as Record<string, unknown>)[rowId]) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw apiError(409, `В решении ${dueRef} нет даты переноса строки (moveTo[«${rowId}»]). ${how}`)
  if (next > to) throw apiError(409, `Перенос по ${dueRef} — не позже «${to}»: эту дату видел владелец`)
  const used = Array.isArray(before.dueRefs) ? before.dueRefs.filter((r): r is string => typeof r === 'string') : []
  if (used.includes(dueRef)) throw apiError(409, `Ответ ${dueRef} уже потрачен на сдвиг этой строки: новый сдвиг — новое решение`)
  if (used.length >= DUE_REFS_MAX) throw apiError(409, `У строки уже ${DUE_REFS_MAX} переносов по ответам — дальше срок меняет только владелец`)
  merged.dueRefs = [...used, dueRef]
  if (before.basePlanEnd === undefined) merged.basePlanEnd = before.planEnd
}
