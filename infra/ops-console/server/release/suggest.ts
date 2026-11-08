/**
 * Предложение следующей версии по коммитам main между текущей версией (base) и привязываемым деплоем (head).
 * Источник — список коммитов GitHub (`/commits?sha=head`, 100 на страницу ≈ 772 КБ), а не compare: compare всегда
 * несёт файлы с патчами (1,75 МБ на 88 коммитов). Идём по первой родительской линии от head до base: на main это
 * merge-коммиты PR и squash-коммиты. Результат кэшируется по `base...head` — коммиты по SHA не меняются.
 */
import { z } from 'zod'
import { decryptSecret } from '../lib/crypto'
import { httpRequest } from '../lib/http'
import { getGithubSettings, readSetting, writeSetting } from '../settings/store'
import { bumpReleaseVersion, formatReleaseVersion, parseReleaseVersion, type ChangeKind, type ReleaseSuggestion } from '../../shared/release'

export const SUGGESTION_KEY = 'release:hr-helper:suggestion'
const PER_PAGE = 100
const MAX_PAGES = 5
const PAGE_MAX_BYTES = 2 * 1024 * 1024
const DAY_MS = 86_400_000
/** Сбой GitHub (лимит, сеть) не повторяем на каждом открытии страницы: следующая попытка — через 5 минут. */
const TRANSIENT_TTL_MS = 5 * 60_000

const MERGE_RE = /^Merge pull request #(\d+) from [^\s/:]+[/:](\S+)/

/** Класс изменения по заголовку коммита: ветка merge-коммита PR, иначе conventional-заголовок squash-коммита. */
export function classifyCommit(message: string): ChangeKind {
  const subject = message.split('\n', 1)[0] ?? ''
  const merge = MERGE_RE.exec(subject)
  if (merge) {
    const branch = merge[2] ?? ''
    if (/^(feature|feat)\//.test(branch)) return 'feature'
    return /^fix\//.test(branch) ? 'fix' : 'other'
  }
  if (/^feat[(:!]/.test(subject)) return 'feature'
  if (/^fix[(:!]/.test(subject)) return 'fix'
  return 'other'
}

const pageSchema = z.array(
  z.object({
    sha: z.string(),
    commit: z.object({ message: z.string() }),
    parents: z.array(z.object({ sha: z.string() })).default([]),
  }),
)

interface Commit {
  subject: string
  parent: string | null
}

export type SuggestOutcome = { ok: true; suggestion: ReleaseSuggestion } | { ok: false; error: string; transient: boolean }

const fail = (error: string, transient = false): SuggestOutcome => ({ ok: false, error, transient })

function httpFailure(status: number): SuggestOutcome {
  if (status === 403 || status === 429) return fail(`GitHub ограничил запросы (HTTP ${status}) — введите версию вручную`, true)
  if (status === 404) return fail('GitHub не отдал коммиты (HTTP 404): токену нужен доступ Contents: read — введите версию вручную', true)
  return fail(`GitHub API: HTTP ${status} — введите версию вручную`, true)
}

interface WalkInput {
  repo: string
  auth: Record<string, string>
  base: string
  head: string
  since: number
}

/** Страница списка коммитов или отказ с текстом для человека. */
async function fetchPage(input: WalkInput, page: number): Promise<z.infer<typeof pageSchema> | SuggestOutcome> {
  const url =
    `https://api.github.com/repos/${input.repo}/commits?sha=${input.head}` +
    `&since=${new Date(input.since).toISOString()}&per_page=${PER_PAGE}&page=${page}`
  let res
  try {
    res = await httpRequest(url, {
      headers: { ...input.auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      timeoutMs: 15_000,
      maxBytes: PAGE_MAX_BYTES,
    })
  } catch (err) {
    return fail(`GitHub не ответил: ${err instanceof Error ? err.message : String(err)}`, true)
  }
  if (!res.ok) return httpFailure(res.status)
  try {
    return pageSchema.parse(JSON.parse(res.text))
  } catch {
    return fail('Ответ GitHub не разобран (больше 2 МБ или другой формат) — введите версию вручную', true)
  }
}

/** Классы коммитов первой родительской линии от head (включая) до base (не включая). */
export async function walkFirstParents(input: WalkInput): Promise<ChangeKind[] | SuggestOutcome> {
  const commits = new Map<string, Commit>()
  const baseKey = input.base.slice(0, 12)
  const kinds: ChangeKind[] = []
  let cursor: string | null = null
  let started = false
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await fetchPage(input, page)
    if (!Array.isArray(items)) return items
    for (const c of items) commits.set(c.sha, { subject: c.commit.message, parent: c.parents[0]?.sha ?? null })
    if (!started) {
      cursor = items.find((c) => c.sha.startsWith(input.head))?.sha ?? null
      started = cursor !== null
    }
    while (cursor) {
      if (cursor.startsWith(baseKey)) return kinds
      const commit = commits.get(cursor)
      if (!commit) break
      kinds.push(classifyCommit(commit.subject))
      cursor = commit.parent
    }
    // Дошли до корня без base или страницы кончились (окно since) — base в этой истории нет.
    if ((started && cursor === null) || items.length < PER_PAGE) break
  }
  return fail(`Коммит текущей версии ${input.base.slice(0, 7)} не найден в истории main (до ${MAX_PAGES * PER_PAGE} коммитов) — введите версию вручную`)
}

function suggestionFrom(currentVersion: string, base: string, head: string, kinds: ChangeKind[]): SuggestOutcome {
  const tuple = parseReleaseVersion(currentVersion)
  if (!tuple) return fail('Текущая версия не в формате v.A.B.C.D')
  if (kinds.length === 0) return fail('Новых коммитов после текущей версии нет')
  const next = bumpReleaseVersion(tuple, kinds)
  if (!next) return fail('Сегмент версии превысил бы 9999 — введите версию вручную')
  const counts: Record<ChangeKind, number> = { feature: 0, fix: 0, other: 0 }
  for (const k of kinds) counts[k] += 1
  return { ok: true, suggestion: { version: formatReleaseVersion(next), base, head, commits: kinds.length, counts } }
}

const cacheSchema = z.object({
  key: z.string().default(''),
  at: z.number().default(0),
  outcome: z
    .union([
      z.object({
        ok: z.literal(true),
        suggestion: z.object({
          version: z.string(),
          base: z.string(),
          head: z.string(),
          commits: z.number(),
          counts: z.object({ feature: z.number(), fix: z.number(), other: z.number() }),
        }),
      }),
      z.object({ ok: z.literal(false), error: z.string(), transient: z.boolean() }),
    ])
    .nullable()
    .default(null),
})

export interface SuggestInput {
  currentVersion: string
  base: string
  head: string
  /** Старт деплоя base, мс; нет такого деплоя — время установки текущей версии. */
  baseAt: number
}

/** Предложение (только для владельца — вызывает маршрут). Кэш по base...head; сбой GitHub — на 5 минут. */
export async function suggestRelease(input: SuggestInput, now = Date.now()): Promise<SuggestOutcome> {
  if (input.head.startsWith(input.base.slice(0, 12)) || input.base.startsWith(input.head)) {
    return fail('Новых коммитов после текущей версии нет')
  }
  const key = `${input.currentVersion}:${input.base}...${input.head}`
  const cached = await readSetting(SUGGESTION_KEY, cacheSchema)
  if (cached.key === key && cached.outcome && (cached.outcome.ok || !cached.outcome.transient || now - cached.at < TRANSIENT_TTL_MS)) {
    return cached.outcome
  }
  const gh = await getGithubSettings()
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh.repo)) return fail('GitHub не настроен: Настройки → Интеграции')
  let auth: Record<string, string> = {}
  try {
    if (gh.tokenEnc) auth = { Authorization: `Bearer ${decryptSecret(gh.tokenEnc)}` }
  } catch {
    return fail('Токен GitHub не расшифровывается — перевыпустите его в Настройки → Интеграции')
  }
  const walked = await walkFirstParents({ repo: gh.repo, auth, base: input.base, head: input.head, since: input.baseAt - DAY_MS })
  const outcome = Array.isArray(walked) ? suggestionFrom(input.currentVersion, input.base, input.head, walked) : walked
  await writeSetting(SUGGESTION_KEY, { key, at: now, outcome })
  return outcome
}
