/**
 * Версия продукта «v.A.B.C.D» (APP-558): формат, сравнение, предложение следующей версии и контракт ответов
 * GET/PUT /api/release для интерфейса. A — номер Лаваэона, его меняют только вручную; B.C.D предлагает расчёт по
 * коммитам main после текущей версии. Без zod: модуль импортирует и веб-бандл.
 */

/** Четыре сегмента 0–9999 без ведущих нулей: «v.0.1.0.0». */
export const RELEASE_VERSION_RE = /^v\.(0|[1-9]\d{0,3})(\.(0|[1-9]\d{0,3})){3}$/
/** SHA, который владелец вставляет сам, когда последний запуск не подтверждён. */
export const RELEASE_SHA_RE = /^[0-9a-f]{7,40}$/
export const RELEASE_NOTE_MAX = 500
export const RELEASE_HISTORY_MAX = 50
export const RELEASE_SEGMENT_MAX = 9999

export type ReleaseTuple = readonly [number, number, number, number]
export type ChangeKind = 'feature' | 'fix' | 'other'

export function parseReleaseVersion(raw: string): ReleaseTuple | null {
  if (!RELEASE_VERSION_RE.test(raw)) return null
  const [a = 0, b = 0, c = 0, d = 0] = raw.slice(2).split('.').map(Number)
  return [a, b, c, d]
}

export const formatReleaseVersion = (t: ReleaseTuple): string => `v.${t.join('.')}`

/** Отрицательное — a ниже b, ноль — равны, положительное — a выше. */
export function compareReleaseVersions(a: ReleaseTuple, b: ReleaseTuple): number {
  for (let i = 0; i < 4; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Счёт по PR (OPS-84, решение владельца taibe-d-ops84-version-1711 = B): каждая feature +1 к B, каждый fix +1 к C.
 * Рост B обнуляет C до счёта fix; рост B или C обнуляет D. Прочие PR дают +1 к D, только если в выпуске нет feature
 * и fix. Пример: v.0.1.2.3 и 33 коммита (12 feature, 16 fix, 5 прочих) → v.0.13.16.0.
 * A не меняется никогда. Нет изменений или сегмент вышел бы за 9999 — предложения нет (null).
 */
export function bumpReleaseVersion(t: ReleaseTuple, kinds: readonly ChangeKind[]): ReleaseTuple | null {
  if (kinds.length === 0) return null
  const [a, b, c, d] = t
  const n = { feature: 0, fix: 0, other: 0 }
  for (const k of kinds) n[k] += 1
  const next: ReleaseTuple =
    n.feature > 0 ? [a, b + n.feature, n.fix, 0] : n.fix > 0 ? [a, b, c + n.fix, 0] : [a, b, c, d + n.other]
  return next.some((x) => x > RELEASE_SEGMENT_MAX) ? null : next
}

// ── Контракт ответов ──────────────────────────────────────────────────────────

export interface ReleaseEntry {
  version: string
  /** Коммит выкаченного деплоя: 12 знаков из таблицы деплоев или вставленный владельцем (7–40). */
  sha: string
  setAt: number
  setBy: string
  note: string
}

/** Почему SHA не берётся сам: новее последнего успешного деплоя есть запуск, который мог менять прод. */
export type BindingReason = 'manual_run' | 'failed_run' | 'in_progress' | 'no_deploy'

export interface BindingRun {
  runKey: string
  url: string
  title: string
  status: string
  conclusion: string | null
  at: number | null
}

export type ReleaseBinding =
  /** SHA последнего успешного не ручного деплоя — к нему привяжется версия. */
  | { mode: 'auto'; sha: string; run: BindingRun }
  /** SHA вставляет владелец; `sha` — последний успешный не ручной деплой (подсказка), `run` — запуск-причина. */
  | { mode: 'confirm'; reason: BindingReason; sha: string | null; run: BindingRun | null }

export interface ReleaseSuggestion {
  version: string
  base: string
  head: string
  /** Коммиты первой родительской линии main от base (не включая) до head. */
  commits: number
  counts: Record<ChangeKind, number>
}

export interface ReleaseResponse {
  /** Ревизия записи: PUT передаёт её как expectedRev, чужая запись между чтением и сохранением — 409. */
  rev: number
  current: ReleaseEntry | null
  /** Прежние версии, новые сверху, до 50. */
  history: ReleaseEntry[]
  binding: ReleaseBinding
  syncError: string | null
}

/** GET /api/release/suggestion — только владельцу, отдельно от основного чтения: GitHub может отвечать секунды. */
export interface ReleaseSuggestionResponse {
  suggestion: ReleaseSuggestion | null
  suggestionError: string | null
}

/** GET /api/release?view=nav — строка в подвале меню: без опроса GitHub, предложения и истории. */
export type ReleaseNav = { version: string; sha: string } | { version: null; sha: null }

/** GET /api/public/release: без sha, автора и заметки. */
export type PublicRelease = { version: string; setAt: number } | { version: null }
