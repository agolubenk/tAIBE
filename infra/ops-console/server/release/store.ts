/**
 * Хранилище версии продукта: один ключ `release:hr-helper` в таблице settings = {rev, current, history}.
 * Запись — сравнение с обменом: ревизия в теле PUT и сырое JSON-значение строки в WHERE. readSetting сюда не годится:
 * при ошибке разбора он отдаёт значения по умолчанию, и запись поверх чужой затёрла бы её без 409.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { settings } from '../db/schema'
import { RELEASE_HISTORY_MAX, RELEASE_NOTE_MAX, RELEASE_VERSION_RE, type ReleaseEntry } from '../../shared/release'

export const RELEASE_KEY = 'release:hr-helper'

const entrySchema = z.object({
  version: z.string().regex(RELEASE_VERSION_RE),
  sha: z.string().max(40),
  setAt: z.number(),
  setBy: z.string().max(120),
  note: z.string().max(RELEASE_NOTE_MAX),
})

const stateSchema = z.object({
  rev: z.number().int().min(0),
  current: entrySchema.nullable(),
  history: z.array(entrySchema).max(RELEASE_HISTORY_MAX),
})

export type ReleaseState = z.infer<typeof stateSchema>

export interface ReleaseSnapshot {
  state: ReleaseState
  /** Сырое значение строки: условие записи. null — строки нет, первая запись вставляет её. */
  raw: string | null
}

const EMPTY: ReleaseState = { rev: 0, current: null, history: [] }

/**
 * Испорченная строка (ручная правка БД) читается как пустая с ревизией 0: владелец может записать версию заново —
 * условие записи по сырому значению всё равно сработает, а подвалы до этого версию не показывают.
 */
export async function readRelease(): Promise<ReleaseSnapshot> {
  const row = await getDb().query.settings.findFirst({ where: eq(settings.key, RELEASE_KEY) })
  if (!row) return { state: EMPTY, raw: null }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(row.value))
    if (parsed.success) return { state: parsed.data, raw: row.value }
  } catch {
    // разбор ниже — как для испорченной строки
  }
  console.warn('[ops] release: запись версии повреждена — читается как пустая')
  return { state: EMPTY, raw: row.value }
}

/** Новая версия: прежняя текущая уходит в начало истории, история — не длиннее 50. */
export function nextReleaseState(prev: ReleaseState, entry: ReleaseEntry): ReleaseState {
  const history = prev.current ? [prev.current, ...prev.history] : prev.history
  return { rev: prev.rev + 1, current: entry, history: history.slice(0, RELEASE_HISTORY_MAX) }
}

/** true — записали; false — строку изменили между чтением и записью (или её вставил параллельный запрос). */
export async function writeRelease(prev: ReleaseSnapshot, next: ReleaseState): Promise<boolean> {
  const db = getDb()
  const value = JSON.stringify(next)
  const updatedAt = new Date()
  if (prev.raw === null) {
    const res = await db.insert(settings).values({ key: RELEASE_KEY, value, updatedAt }).onConflictDoNothing()
    return res.rowsAffected === 1
  }
  const res = await db
    .update(settings)
    .set({ value, updatedAt })
    .where(and(eq(settings.key, RELEASE_KEY), eq(settings.value, prev.raw)))
  return res.rowsAffected === 1
}
