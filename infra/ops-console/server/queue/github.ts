/**
 * Мёрж и деплой из очереди владельца (веб /queue и Telegram-бот очереди). Гарантии:
 *  - вливается только то, что одобрил «Контроль»: полный SHA головы (`sha`) и база PR (`base`) в пункте мёржа.
 *    Вердикта нет — кнопка неактивна, сервер отказывает; голова или база PR сменились после вердикта — отказ до
 *    нового вердикта (одна и та же голова в PR на склейку и в PR на main — разные вливания);
 *  - вливается ровно тот head SHA, который показали владельцу (GitHub сам откажет, если ветку допушили);
 *  - [skip ci] — из пункта (deploy: 'skip', команда мёржа или subject с [skip ci], [ci skip], [no ci], [skip actions],
 *    [actions skip]); иначе мёрж в main запускает деплой прода, и заголовок с текстом коммита уходят явно, без этих меток;
 *  - способ (merge|squash) и заголовок коммита — из пункта (mergeMethod, subject) или его команды (--squash, --subject);
 *  - PR другого репозитория (поле repo, -R, URL PR или GH_REPO в команде) — честный отказ 409 до запроса к GitHub (Q-29);
 *    команду, которую консоль не повторит как терминал (cd, $(…), rebase, флаг без значения), — тоже 409;
 *  - POST /merge несёт версию пункта с экрана подтверждения: пункт меняли после показа — 409;
 *  - пока идёт деплой, мёрж с деплоем запрещён: влитые подряд схлопнулись бы в один деплой;
 *  - не чаще одного мёржа за 30 с на консоль; каждое действие — в журнал очереди.
 * Токен — отдельный от токена опроса деплоев (Настройки → GitHub): fine-grained, только этот репозиторий,
 * contents/pull_requests/actions на запись. Выставляется CLI: `npm run oq -- merge-token`.
 */
import { z } from 'zod'
import { getGithubSettings } from '../settings/store'
import { decryptSecret } from '../lib/crypto'
import { httpRequest } from '../lib/http'
import { apiError } from '../http-types'
import { DEFAULT_PRODUCT } from './products'
import { getDoc, logEvent, writeDoc, type Actor } from './store'

export interface GithubResponse {
  status: number
  text: string
}
type Transport = (method: 'GET' | 'POST' | 'PUT', path: string, token: string, body?: unknown) => Promise<GithubResponse>

const realTransport: Transport = async (method, path, token, body) => {
  const res = await httpRequest(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
  })
  return { status: res.status, text: res.text }
}
let transport: Transport = realTransport
const MERGE_GAP_MS = 30_000
let lastMergeAt = 0

/** Подмена транспорта в тестах; заодно сбрасывает паузу между мёржами, чтобы тесты не зависели от порядка. */
export function setGithubTransportForTests(t: Transport | null): void {
  transport = t ?? realTransport
  lastMergeAt = 0
}

const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  merged: z.boolean().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  html_url: z.string(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
})
const runsSchema = z.object({ workflow_runs: z.array(z.object({ status: z.string().nullable() })) })

export interface MergePlan {
  pr: number | null
  skipCi: boolean
  deploys: boolean
  /** Голова PR, одобренная «Контролем» (поле `sha` пункта); null — вердикта нет. */
  approvedSha: string | null
  /** База PR, для которой дан вердикт (поле `base` пункта); null — вердикта нет. */
  approvedBase: string | null
  /** Репозиторий PR (`owner/name`) из поля `repo` или `-R` команды; null — репозиторий из настроек консоли. */
  repo: string | null
  /** Способ мёржа: поле `mergeMethod` или `--squash` команды; по умолчанию merge. */
  method: 'merge' | 'squash'
  /** Заголовок коммита: поле `subject` или `--subject` команды; null — заголовок GitHub по способу. */
  subject: string | null
  /** Почему консоль не повторит команду пункта (cd, $(…), rebase, флаг без значения, два репозитория); null — повторит. */
  problem: string | null
}

const FULL_SHA = /^[0-9a-f]{40}$/
export const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/
const SUBJECT = /^[^\r\n]{1,300}$/
/**
 * Метки, по которым GitHub Actions не запускает workflow на push (docs: «Skipping workflow runs»): пять в скобках и
 * трейлер `skip-checks: true` в конце сообщения. SKIP_MARKER — в заголовке (там трейлера не бывает), SKIP_ANY — в команде.
 */
const SKIP_MARKER = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i
const SKIP_ANY = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i
const SKIP_MARKERS = / ?\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/gi
const SKIP_TRAILER = /^[ \t]*skip-checks:[ \t]*true[ \t]*$/gim
/** До неподвижной точки: из «[sk[skip ci]ip ci]» один проход оставил бы «[skip ci]» (ревью безопасности). */
const unskip = (s: string): string => {
  let prev: string
  do { prev = s; s = s.replace(SKIP_MARKERS, '').replace(SKIP_TRAILER, '') } while (s !== prev)
  return s
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** `[HOST/]OWNER/REPO`, как принимает `gh -R`, и URL репозитория → `owner/name`. */
const repoName = (v: string): string => v.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')

/** Флаги gh со значением; остальные — булевы. Короткие: -R -t -b -F -A. */
const VALUE_LONG = new Set(['--repo', '--subject', '--body', '--body-file', '--match-head-commit', '--author-email'])
const VALUE_SHORT: Record<string, string> = { R: '--repo', t: '--subject', b: '--body', F: '--body-file', A: '--author-email' }
const SHORT_BOOL: Record<string, string> = { s: '--squash', m: '--merge', r: '--rebase', d: '--delete-branch' }

interface MergeFlags {
  pr: number | null
  /** Репозиторий из -R/--repo, из URL PR в аргументе или из GH_REPO= перед командой. */
  repo: string | null
  method: 'merge' | 'squash' | null
  subject: string | null
  /** Только сама команда мёржа (без того, что после && ; |) — по ней ищем метки пропуска CI. */
  segment: string
  /** Что делает команду неоднозначной для консоли, по полю, которое из неё берётся; поле пункта снимает отказ. other — не снимает ничто. */
  problems: { repo?: string; method?: string; subject?: string; other?: string }
}

/** Части команды до разделителя (\n ; & |): кавычки и экранирование `\x` — часть слова, разделитель в них не режет. */
// `>&`, `<&` и `&>` — перенаправление, а не разделитель `&`: «… 2>&1 --squash» — та же команда.
const GH_PR = /\bgh[ \t]+pr\b(?:\\[\s\S]|[<>]&|&>|[^\n;&|"'\\]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')*/g
const SHELL_WORD = /(?:\\[\s\S]|[^\s"'\\]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+/g
/** Перенаправление shell (`2>&1`, `>file`, `2>/dev/null`, `<in`, `&>log`): shell снимает его до запуска, gh его не видит. */
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|<&|>\||<>|<<<|<<|>|<)/
/** Слова shell команды без перенаправлений; у голого оператора (`2>`, `>`) цель — следующее слово (ревью «Контроля» #114, F1). */
function commandWords(seg: string): string[] {
  const raw = seg.match(SHELL_WORD) ?? []
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i] ?? ''
    const op = REDIRECT.exec(w)
    if (!op) out.push(w)
    else if (op[0].length === w.length) i++
  }
  return out
}
/** Слово shell → значение: кавычки сняты, `\x` → x (в двойных кавычках — только для $ ` " \ и перевода строки). */
const unquote = (w: string): string =>
  w.replace(/\\([\s\S])|"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'/g, (_m, esc?: string, dq?: string, sq?: string) =>
    esc ?? (dq !== undefined ? dq.replace(/\\([$`"\\\n])/g, '$1') : sq ?? ''))

/**
 * Флаги `gh pr merge …` по словам shell, как их разбирает gh (pflag), а не по сырому тексту: `--subject "fix -s flag"` —
 * заголовок, а не squash; `-ds` — delete-branch и squash; `-Rowner/name` — репозиторий. Только сама команда мёржа:
 * `curl -s` или `git log -t` после && способ не меняют. Всё, что консоль не повторит как терминал (cd в другую папку,
 * подстановка $(…), rebase, флаг без значения), — в problems: mergeInfo откажет 409, а не вольёт другое.
 */
function mergeFlags(cmd: string): MergeFlags {
  // Все `gh pr …` команды; мёрж — та, где первое слово после pr и его флагов (`gh pr -R x merge`) — merge.
  const merges = [...cmd.matchAll(GH_PR)].filter((m) => {
    const ws = commandWords(m[0]).slice(2).map(unquote)
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i] ?? ''
      if (w === '-R' || w === '--repo') { i++; continue }
      if (!w.startsWith('-')) return w === 'merge'
    }
    return false
  })
  const found = merges[0]
  const segment = found?.[0] ?? ''
  const before = found ? cmd.slice(0, found.index) : ''
  const raw = commandWords(segment)
  const words = raw.map(unquote)
  // $ и ` вне одинарных кавычек и без \ перед ними shell подставит — консоль увидела бы буквальный текст.
  // <( и >( — подстановка процесса: REDIRECT пропускает её как аргумент, а заголовком стал бы текст «<(cat)»
  // (линза корректности #543, F2). В двойных кавычках это буквальный текст — тогда отказ лишний, но безопасный.
  const expands = (i: number) => /[$`]|[<>]\(/.test((raw[i] ?? '').replace(/'[^']*'|\\[\s\S]/g, ''))
  const out: MergeFlags = { pr: null, repo: null, method: null, subject: null, segment, problems: {} }
  if (merges.length > 1) out.problems.other = `в команде ${merges.length} мёржа — консоль вливает один PR за пункт`
  // Кавычка без пары обрезала разбор: флаги после неё консоль не увидела бы.
  if (found && /["']/.test(cmd[(found.index ?? 0) + segment.length] ?? '')) out.problems.other ??= 'в команде кавычка без пары'
  if (!found && /\bgh\b/.test(cmd) && /\bmerge\b/.test(cmd)) out.problems.repo = 'команду мёржа консоль не разобрала — PR и репозиторий из неё не ясны'
  let sub = false
  const repos: string[] = []
  const methods = new Set<string>()
  const field = (flag: string): keyof MergeFlags['problems'] | null => (flag === '--repo' ? 'repo' : flag === '--subject' ? 'subject' : null)
  const take = (flag: string, value: string | null, i: number) => {
    const f = field(flag)
    if (!f) return
    // gh взял бы и «--squash» как значение -t — это опечатка в пункте, а не заголовок.
    if (value === null || value === '' || value.startsWith('-')) out.problems[f] = `в команде у флага ${flag} нет значения`
    else if (expands(i)) out.problems[f] = `в значении ${flag} подстановка shell ($, \` или <(…)) — консоль её не выполнит`
    else if (f === 'repo') repos.push(repoName(value))
    else out.subject = value
  }
  const flagOn = (flag: string) => {
    if (flag === '--squash' || flag === '--merge' || flag === '--rebase') methods.add(flag.slice(2))
  }
  for (let i = 2; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const flag = eq > 0 ? word.slice(0, eq) : word
      if (VALUE_LONG.has(flag)) {
        // Аргументы вычисляются слева направо: третий — индекс слова со значением (после ++i — следующее слово).
        take(flag, eq > 0 ? word.slice(eq + 1) : (words[++i] ?? null), i)
      } else flagOn(flag)
    } else if (word.length > 1 && word.startsWith('-')) {
      // Связка коротких: -ds = -d -s; у флага со значением остаток слова — значение (-Rowner/name, -R=owner/name).
      for (let j = 1; j < word.length; j++) {
        const long = VALUE_SHORT[word[j] ?? '']
        if (long) {
          const rest = word.slice(j + 1).replace(/^=/, '')
          take(long, rest || (words[++i] ?? null), i)
          break
        }
        const bool = SHORT_BOOL[word[j] ?? '']
        if (bool) flagOn(bool)
      }
    } else if (!sub) {
      sub = word === 'merge' // слово команды gh: до него — флаги `gh pr`, после — аргумент мёржа
    } else if (out.pr === null) {
      // Аргумент: номер, #номер или URL PR (репозиторий — из URL, хвост /files, ?…, #… не мешает).
      const url = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(word)
      if (url) { repos.push(repoName(url[1] ?? '')); out.pr = Number(url[2]) || null }
      else if (/^#?\d+$/.test(word)) out.pr = Number(word.replace('#', '')) || null
      // Ветку или чужой URL gh разрешит сам, консоль — нет: какой PR и в каком репозитории, не ясно.
      else out.problems.repo ??= `аргумент «${word.slice(0, 80)}» консоль не разбирает — нужен номер PR`
    } else out.problems.repo ??= 'в команде мёржа больше одного аргумента'
  }
  const env = [...before.matchAll(/\bGH_REPO=("[^"]*"|'[^']*'|[^\s;&|]+)/g)].pop()?.[1]
  if (env) repos.push(repoName(env.replace(/^["']|["']$/g, '')))
  const distinct = [...new Set(repos.map((r) => r.toLowerCase()))]
  if (distinct.length > 1) out.problems.repo = `команда называет разные репозитории: ${[...new Set(repos)].join(', ')}`
  else if (repos[0]) out.repo = repos[0]
  // cd и внутри кавычек: `bash -c "cd … && gh pr merge"`, `ssh host 'cd …'` — gh тоже в другой папке.
  else if (/(?:^|[\s;&|("'`])(?:cd|pushd)\s/.test(before)) out.problems.repo ??= 'команда сначала переходит в другую папку (cd), репозиторий PR из неё не ясен'
  if (methods.has('rebase')) out.problems.method = 'rebase из очереди не поддерживается (только merge и squash)'
  else if (methods.size > 1) out.problems.method = 'в команде несколько способов мёржа сразу'
  else out.method = methods.has('squash') ? 'squash' : methods.has('merge') ? 'merge' : null
  return out
}

/** Номер PR и последствия мёржа — из полей пункта или (для пунктов из артефакта) из его команды и меток. */
export function mergePlan(item: Record<string, unknown>): MergePlan {
  const cmd = typeof item.cmd === 'string' ? item.cmd : ''
  const flags = mergeFlags(cmd)
  const pr = typeof item.pr === 'number' ? item.pr : flags.pr
  const approvedSha = typeof item.sha === 'string' && FULL_SHA.test(item.sha) ? item.sha : null
  const approvedBase = typeof item.base === 'string' && BRANCH_NAME.test(item.base) ? item.base : null
  // Поле пункта главнее команды; противоречие команде — отказ, а не выбор одного из двух.
  const itemRepo = str(item.repo)
  // Не проверяем формат здесь: кривое имя не совпадёт с репозиторием консоли, и mergeInfo откажет (fail-closed).
  const repo = itemRepo ?? flags.repo
  const problems = [
    itemRepo && flags.repo && itemRepo.toLowerCase() !== flags.repo.toLowerCase()
      ? `поле repo (${itemRepo}) и команда (${flags.repo}) называют разные репозитории`
      : itemRepo ? null : flags.problems.repo,
    item.mergeMethod === undefined ? flags.problems.method : null,
    str(item.subject) ? null : flags.problems.subject,
    flags.problems.other,
    typeof item.pr === 'number' && flags.pr !== null && flags.pr !== item.pr ? `поле pr (#${item.pr}) и команда (#${flags.pr}) называют разные PR` : null,
  ].filter((p): p is string => !!p)
  const method = item.mergeMethod === 'squash' || (item.mergeMethod === undefined && flags.method === 'squash') ? 'squash' : 'merge'
  const subjectRaw = str(item.subject) ?? flags.subject
  const subject = subjectRaw && SUBJECT.test(subjectRaw.trim()) ? subjectRaw.trim() : null
  // Заголовок задан, но не годится — отказ, а не тихий заголовок по умолчанию (линза корректности #543, F3).
  if (subjectRaw && !subject) problems.push(`заголовок коммита (${str(item.subject) ? 'поле subject' : 'флаг --subject'}) — нужна одна строка до 300 символов`)
  const skipCi = item.deploy === 'skip' || SKIP_ANY.test(flags.segment) || SKIP_MARKER.test(subject ?? '')
  // Мёрж в main с кодом деплоит прод — поэтому деплой ожидается, если пункт не говорит обратное:
  // [skip ci], deploy: 'none' (только docs/md — paths-ignore) или метка «без деплоя».
  const chips = Array.isArray(item.chips) ? (item.chips as unknown[][]) : []
  const saysNoDeploy = chips.some((c) => Array.isArray(c) && typeof c[0] === 'string' && /без деплоя/i.test(c[0]))
  const deploys = item.deploy ? item.deploy === 'deploy' : !skipCi && !saysNoDeploy
  return { pr, skipCi, deploys, approvedSha, approvedBase, repo, method, subject, problem: problems.length ? problems.join('; ') : null }
}

/**
 * Тело PUT /pulls/N/merge. Заголовок и текст коммита — всегда явно: иначе GitHub собрал бы их сам (у squash — из
 * сообщений коммитов ветки, у HR так настроено), и `[skip ci]` из любого коммита ветки молча отменил бы деплой, который
 * консоль обещает. Без деплоя — метка в заголовке; с деплоем — метки вычищены и из заголовка, и из текста.
 */
export function mergeRequestBody(
  info: Pick<MergeInfo, 'pr' | 'title' | 'headRef' | 'skipCi' | 'method' | 'subject' | 'repo'>,
  sha: string,
  commits: string[] | null = null,
): Record<string, unknown> {
  const squash = info.method === 'squash'
  let title = info.subject ?? (squash ? `${info.title} (#${info.pr})` : `Merge pull request #${info.pr} from ${info.repo.split('/')[0]}/${info.headRef}`)
  title = info.skipCi ? (SKIP_MARKER.test(title) ? title : `${title} [skip ci]`) : unskip(title).trim()
  // Текст: у squash — сообщения коммитов ветки (как GitHub по умолчанию), у merge — заголовок PR (тоже как GitHub).
  const message = squash && commits?.length ? commits.map((m) => `* ${m.trim()}`).join('\n\n') : info.title
  return { sha, merge_method: info.method, commit_title: title, commit_message: unskip(message) }
}

const commitsSchema = z.array(z.object({ commit: z.object({ message: z.string() }) }))

/** Сообщения коммитов PR (до 100 — одна страница) для текста squash; не прочитались — null, текст будет заголовком PR. */
async function prCommits(repo: string, pr: number, token: string): Promise<string[] | null> {
  const res = await call('GET', `/repos/${repo}/pulls/${pr}/commits?per_page=100`, token)
  if (res.status !== 200) return null
  try {
    const parsed = commitsSchema.safeParse(JSON.parse(res.text))
    return parsed.success ? parsed.data.map((c) => c.commit.message) : null
  } catch {
    return null
  }
}

/** Вердикт против PR на GitHub: нет вердикта (нужны оба поля), сменилась голова, сменилась база — или всё совпало. */
function approvalOf(plan: MergePlan, headSha: string, baseRef: string): MergeInfo['approval'] {
  if (!plan.approvedSha || !plan.approvedBase) return 'missing'
  if (plan.approvedSha !== headSha) return 'mismatch'
  return plan.approvedBase === baseRef ? 'ok' : 'base'
}

async function settings() {
  const gh = await getGithubSettings()
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh.repo) || !/^[\w.-]+$/.test(gh.workflow)) throw apiError(503, 'GitHub не настроен: репозиторий или workflow')
  if (!gh.mergeTokenEnc) throw apiError(503, 'Нет токена для мёржей: на сервере выполните npm run oq -- merge-token (README очереди)')
  return { repo: gh.repo, workflow: gh.workflow, token: decryptSecret(gh.mergeTokenEnc) }
}

async function call(method: 'GET' | 'POST' | 'PUT', path: string, token: string, body?: unknown): Promise<GithubResponse> {
  const res = await transport(method, path, token, body)
  if (res.status === 401 || res.status === 403) throw apiError(503, `GitHub отказал (${res.status}): проверьте токен для мёржей и его права`)
  return res
}

/**
 * Чтение GraphQL репозитория консоли токеном мёржей — для графика PR на /queue (queue/prs.ts). REST /pulls несёт
 * описания и объекты репозиториев (~20 КБ на PR, сотня — за потолком 1 МБ), GraphQL — только запрошенные поля.
 * Переменные owner и name — из настроек консоли.
 */
export async function githubGraphql(query: string, variables: Record<string, unknown>): Promise<{ repo: string; data: unknown }> {
  const { repo, token } = await settings()
  const [owner, name] = repo.split('/')
  const res = await call('POST', '/graphql', token, { query, variables: { ...variables, owner, name } })
  if (res.status !== 200) throw apiError(503, `GitHub GraphQL ответил ${res.status}`)
  const j = JSON.parse(res.text) as { data?: unknown; errors?: Array<{ message?: string }> }
  if (j.errors?.length) throw apiError(503, `GitHub GraphQL: ${String(j.errors[0]?.message ?? 'ошибка').slice(0, 200)}`)
  return { repo, data: j.data }
}

async function deployRunning(repo: string, workflow: string, token: string): Promise<boolean> {
  const res = await call('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=5`, token)
  if (res.status !== 200) return false
  return runsSchema.parse(JSON.parse(res.text)).workflow_runs.some((r) => r.status !== 'completed')
}

export interface MergeInfo extends Omit<MergePlan, 'repo'> {
  itemId: string
  /** Версия пункта, по которой построен экран: POST /merge с другой версией — 409 (пункт меняли после показа). */
  version: number
  /** Репозиторий, где лежит PR (всегда репозиторий консоли: чужой mergeInfo отклоняет до запроса). */
  repo: string
  title: string
  url: string
  headSha: string
  headRef: string
  baseRef: string
  state: string
  mergeable: boolean | null
  mergeableState: string
  deployRunning: boolean
  /**
   * ok — голова и база PR те, что одобрил «Контроль»; missing — вердикта в пункте нет (нужны sha и base);
   * mismatch — после вердикта ветку меняли; base — после вердикта сменили базу PR.
   */
  approval: 'ok' | 'missing' | 'mismatch' | 'base'
}

/** Всё для экрана подтверждения: что вливаем, какой SHA, будет ли деплой и не идёт ли он сейчас. */
export async function mergeInfo(itemId: string, shownVersion?: number): Promise<MergeInfo> {
  const item = await getDoc('items', itemId, '*')
  if (!item || item.data.kind !== 'merge') throw apiError(404, 'Нет такого пункта мёржа')
  // Версия экрана — до запросов к GitHub: устаревший клик не тратит два вызова API (линза ресурсов #543).
  if (shownVersion !== undefined && item.version !== shownVersion) {
    throw apiError(409, 'Пункт изменился после показа (способ, заголовок или деплой могли стать другими) — откройте мёрж заново')
  }
  // Репозиторий и токен мёржа — пока только HR (настройки консоли): пункт другого продукта влил бы PR не в тот
  // репозиторий. Мёрж по продукту — после точки невозврата PNR-1 (план, фаза 7), отдельным «да».
  if (item.product !== DEFAULT_PRODUCT) throw apiError(409, `Мёрж из очереди для продукта «${item.product}» ещё не подключён`)
  const plan = mergePlan(item.data)
  if (!plan.pr) throw apiError(422, 'В пункте нет номера PR (поле pr или команда gh pr merge N)')
  if (plan.problem) throw apiError(409, `PR #${plan.pr}: ${plan.problem} — влейте командой из пункта в терминале или задайте поля пункта (repo, mergeMethod, subject)`)
  const { repo, workflow, token } = await settings()
  // Номер PR без репозитория читался из репозитория консоли: tAIBE #41 показывался как влитый HR #41 (Q-29).
  if (plan.repo && plan.repo.toLowerCase() !== repo.toLowerCase()) {
    throw apiError(409, `PR #${plan.pr} — в репозитории ${plan.repo}, а мёрж из очереди подключён только к ${repo}: влейте командой из пункта в терминале`)
  }
  const res = await call('GET', `/repos/${repo}/pulls/${plan.pr}`, token)
  if (res.status === 404) throw apiError(404, `PR #${plan.pr} не найден`)
  if (res.status !== 200) throw apiError(503, `GitHub: HTTP ${res.status}`)
  const pr = prSchema.parse(JSON.parse(res.text))
  return {
    ...plan,
    repo,
    itemId,
    version: item.version,
    title: pr.title,
    url: pr.html_url,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    state: pr.merged ? 'merged' : pr.state,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? '',
    deployRunning: await deployRunning(repo, workflow, token),
    approval: approvalOf(plan, pr.head.sha, pr.base.ref),
  }
}

export async function mergeItem(actor: Actor, itemId: string, sha: string, version?: number): Promise<{ sha: string; message: string }> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Вливает только владелец')
  if (!/^[0-9a-f]{40}$/.test(sha)) throw apiError(422, 'Нужен полный SHA, показанный на экране подтверждения')
  // Способ, заголовок и деплой берутся из пункта заново: без версии экрана агент мог бы поменять их между показом и кликом.
  if (version === undefined) {
    throw apiError(422, 'Нужна версия пункта с экрана подтверждения — откройте мёрж заново (на странице — после обновления; в Telegram — после обновления бота очереди)')
  }
  if (Date.now() - lastMergeAt < MERGE_GAP_MS) throw apiError(429, 'Мёржи не чаще раза в 30 секунд — подождите')
  const info = await mergeInfo(itemId, version)
  if (info.state !== 'open') throw apiError(409, info.state === 'merged' ? `PR #${info.pr} уже влит` : `PR #${info.pr} закрыт`)
  if (info.approval === 'missing') {
    throw apiError(409, `В пункте нет вердикта «Контроля» по PR #${info.pr} (поля sha и base) — вливать нельзя до вердикта`)
  }
  if (info.approval === 'mismatch') {
    throw apiError(409, `Голова PR #${info.pr} — ${info.headSha.slice(0, 7)}, а «Контроль» одобрил ${info.approvedSha?.slice(0, 7)}: после вердикта ветку меняли — нужен новый вердикт`)
  }
  if (info.approval === 'base') {
    throw apiError(409, `«Контроль» одобрил PR #${info.pr} для базы «${info.approvedBase}», а сейчас база «${info.baseRef}» — нужен новый вердикт`)
  }
  if (info.headSha !== sha) throw apiError(409, `В ветку допушили после показа (было ${sha.slice(0, 7)}, сейчас ${info.headSha.slice(0, 7)}) — откройте пункт заново`)
  if (info.mergeable === false) throw apiError(409, `GitHub не даёт влить: ${info.mergeableState || 'конфликт'}`)
  if (info.deploys && !info.skipCi && info.deployRunning && info.baseRef === 'main') throw apiError(409, 'Сейчас идёт деплой — дождитесь его окончания, затем вливайте')
  const { repo, token } = await settings()
  // До чтения коммитов: окно, в котором второй POST проходит интервал, не шире прежнего (гонка целиком — карточка Q-35).
  lastMergeAt = Date.now()
  const commits = info.method === 'squash'
    ? await prCommits(repo, info.pr as number, token).catch((e: unknown) => { lastMergeAt = 0; throw e })
    : null
  const body = mergeRequestBody(info, sha, commits)
  const res = await call('PUT', `/repos/${repo}/pulls/${info.pr}/merge`, token, body)
  if (res.status !== 200) {
    lastMergeAt = 0
    const msg = (() => { try { return String(JSON.parse(res.text).message ?? '') } catch { return '' } })()
    throw apiError(409, `GitHub не влил PR #${info.pr}: ${msg || `HTTP ${res.status}`}`)
  }
  const merged = JSON.parse(res.text) as { sha?: string }
  const consequence = info.skipCi ? 'без деплоя ([skip ci])' : info.deploys && info.baseRef === 'main' ? 'запущен деплой прода' : 'деплой не ожидается'
  const message = `Влит PR #${info.pr} (${sha.slice(0, 7)}, ${info.method}), ${consequence}`
  const prevNote = (await getDoc('checks', itemId, '*'))?.data.note
  const note = typeof prevNote === 'string' && prevNote.trim() ? `${prevNote}\n${message}` : message
  await writeDoc({ name: actor.name, scopes: ['owner'], products: '*' }, 'checks', itemId, { done: true, note: note.slice(-20_000), at: new Date().toISOString() }, { merge: true })
  await logEvent(actor.name, 'items', itemId, 'merge', { pr: info.pr, sha, mergeSha: merged.sha, skipCi: info.skipCi, method: info.method, repo }, DEFAULT_PRODUCT)
  return { sha: merged.sha ?? '', message }
}

/** Перезапуск деплоя: workflow_dispatch на main. */
export async function redeploy(actor: Actor): Promise<string> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Деплой запускает только владелец')
  const { repo, workflow, token } = await settings()
  if (await deployRunning(repo, workflow, token)) throw apiError(409, 'Деплой уже идёт')
  const res = await call('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, token, { ref: 'main' })
  if (res.status !== 204) throw apiError(409, `GitHub не запустил деплой: HTTP ${res.status}`)
  await logEvent(actor.name, 'deploy', 'main', 'redeploy', undefined, null)
  return 'Деплой main запущен'
}
