/**
 * Хранилище версии продукта: один ключ `release:hr-helper` в таблице settings = {rev, current, history}.
 * Запись — сравнение с обменом: ревизия в теле PUT и сырое JSON-значение строки в WHERE. readSetting сюда не годится:
 * при ошибке разбора он отдаёт значения по умолчанию, и запись поверх чужой затёрла бы её без 409.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { settings } from '../db/schema'
import { apiError } from '../http-types'
import { logActivity } from '../activity'
import { RELEASE_HISTORY_MAX, RELEASE_NOTE_MAX, RELEASE_VERSION_RE, type ReleaseEntry } from '../../shared/release'

export const RELEASE_KEY = 'release:hr-helper'
/** Копия повреждённой строки: запись поверх неё не теряет данные для ручного разбора. */
export const RELEASE_BACKUP_KEY = 'release:hr-helper:backup'

const entrySchema = z.object({
  version: z.string().regex(RELEASE_VERSION_RE),
  sha: z.string().max(40),
  setAt: z.number(),
  /** Почта автора: до 320 знаков по RFC 5321. */
  setBy: z.string().max(320),
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
  /** Строка есть, но не разбирается: перед записью её копия уходит в RELEASE_BACKUP_KEY. */
  corrupt: boolean
}

const EMPTY: ReleaseState = { rev: 0, current: null, history: [] }

/**
 * Испорченная строка (ручная правка БД) читается как пустая с ревизией 0: владелец может записать версию заново —
 * условие записи по сырому значению всё равно сработает, а подвалы до этого версию не показывают.
 */
export async function readRelease(): Promise<ReleaseSnapshot> {
  const row = await getDb().query.settings.findFirst({ where: eq(settings.key, RELEASE_KEY) })
  if (!row) return { state: EMPTY, raw: null, corrupt: false }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(row.value))
    if (parsed.success) return { state: parsed.data, raw: row.value, corrupt: false }
  } catch {
    // разбор ниже — как для испорченной строки
  }
  console.warn('[ops] release: запись версии повреждена — читается как пустая')
  return { state: EMPTY, raw: row.value, corrupt: true }
}

async function backupCorrupt(raw: string, actor: string): Promise<void> {
  const updatedAt = new Date()
  await getDb()
    .insert(settings)
    .values({ key: RELEASE_BACKUP_KEY, value: raw, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value: raw, updatedAt } })
  await logActivity('config', `Повреждённая запись версии сохранена в ${RELEASE_BACKUP_KEY}`, actor, '/deploys')
}

/** Новая версия: прежняя текущая уходит в начало истории, история — не длиннее 50. */
export function nextReleaseState(prev: ReleaseState, entry: ReleaseEntry): ReleaseState {
  const history = prev.current ? [prev.current, ...prev.history] : prev.history
  return { rev: prev.rev + 1, current: entry, history: history.slice(0, RELEASE_HISTORY_MAX) }
}

/**
 * true — записали; false — строку изменили между чтением и записью (или её вставил параллельный запрос).
 * Новое состояние проходит ту же схему, что и чтение: запись, которую потом не прочитать, не уходит в БД.
 */
export async function writeRelease(prev: ReleaseSnapshot, next: ReleaseState): Promise<boolean> {
  const checked = stateSchema.safeParse(next)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    throw apiError(400, `Запись версии не прошла проверку: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'формат'}`)
  }
  if (prev.corrupt && prev.raw !== null) await backupCorrupt(prev.raw, next.current?.setBy ?? 'system')
  const db = getDb()
  const value = JSON.stringify(checked.data)
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
