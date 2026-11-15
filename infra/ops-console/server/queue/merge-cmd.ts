/**
 * Разбор команды пункта очереди по словам shell, как её разобрал бы gh (pflag): номер PR, репозиторий, способ и
 * заголовок коммита, и всё, что консоль не повторит как терминал. Чистые функции без зависимостей; вынесено из
 * github.ts (лимит 500 строк), там же — правила, по которым mergePlan сводит это с полями пункта.
 */

/** `[HOST/]OWNER/REPO`, как принимает `gh -R`, и URL репозитория → `owner/name`. */
const repoName = (v: string): string => v.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')

/** Флаги gh со значением; остальные — булевы. Короткие: -R -t -b -F -A. */
const VALUE_LONG = new Set(['--repo', '--subject', '--body', '--body-file', '--match-head-commit', '--author-email'])
const VALUE_SHORT: Record<string, string> = { R: '--repo', t: '--subject', b: '--body', F: '--body-file', A: '--author-email' }
const SHORT_BOOL: Record<string, string> = { s: '--squash', m: '--merge', r: '--rebase', d: '--delete-branch' }

export interface MergeFlags {
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
// `<(…)` и `>(…)` — подстановка процесса, это аргумент gh (путь /dev/fd/N), а не перенаправление (LOW «Контроля» c1, #114).
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|<&|>\||<>|<<<|<<|>(?!\()|<(?!\())/
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
export function mergeFlags(cmd: string): MergeFlags {
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
  const env = envRepos(before, out.pr)
  if (env.problems[0]) out.problems.repo ??= env.problems[0]
  const last = env.repos.pop() // присваивания подряд — действует последнее
  if (last) repos.push(last)
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

/** Репозитории, названные в строке, и причины, по которым репозиторий из неё не ясен (подстановка shell). */
export interface FoundRepos {
  repos: string[]
  problems: string[]
}

/** `owner/name` и `HOST/OWNER/REPO` (GitHub Enterprise — чужой консоли репозиторий, отказ 409, а не пропуск). */
const REPO = /^(?:[\w-]+\.[\w.-]+\/)?[\w.-]+\/[\w.-]+$/
/** Команда shell до разделителя (\n ; & |), разделитель в кавычках не режет. */
const SEGMENT = /(?:\\[\s\S]|[<>]&|&>|[^\n;&|"'\\]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+/g
const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i
/** $ и ` вне одинарных кавычек и без \ перед ними shell подставит; <( и >( — подстановка процесса. */
const expandsRaw = (raw: string) => /[$`]|[<>]\(/.test(raw.replace(/'[^']*'|\\[\s\S]/g, ''))

/** Значение -R, --repo, GH_REPO= или URL PR: имя — в repos; подстановка shell — в problems; не имя репозитория — мимо. */
function addRepo(out: FoundRepos, raw: string, value: string, what: string): void {
  if (expandsRaw(raw)) {
    out.problems.push(`в значении ${what} подстановка shell ($, \` или <(…)) — консоль её не выполнит`)
    return
  }
  const name = repoName(value.split(/[;&|)]/)[0] ?? '')
  if (REPO.test(name)) out.repos.push(name)
}

/** -R/--repo и URL PR команды `gh pr <что-то> …`; same — команда о PR с номером pr. */
function ghPrFlags(raw: string[], words: string[], from: number, pr: number | null): FoundRepos & { same: boolean } {
  const out = { repos: [] as string[], problems: [] as string[], same: false }
  for (let k = from; k < words.length; k++) {
    const w = words[k] ?? ''
    if (/\s/.test(w)) continue // значение в кавычках с пробелом (--body "… -R x/y …") — текст, а не флаг
    const bundle = w.startsWith('--') ? null : /^-[A-Za-z]*R=?(.*)$/.exec(w) // -R x, -Rx, -R=x, связка -wR x
    if (w === '--repo' || (bundle && !bundle[1])) { addRepo(out, raw[k + 1] ?? '', words[k + 1] ?? '', w); k++; continue }
    if (bundle || w.startsWith('--repo=')) { addRepo(out, raw[k] ?? '', bundle ? bundle[1] ?? '' : w.slice(7), '-R'); continue }
    const url = PR_URL.exec(w)
    if (url && Number(url[2]) === pr) { out.same = true; addRepo(out, raw[k] ?? '', url[1] ?? '', 'URL PR') }
    else if (/^#?\d+$/.test(w) && Number(w.replace('#', '')) === pr) out.same = true
  }
  return out
}

/**
 * Репозитории, названные в строке о PR `pr`, по командам shell. Программа — первое слово команды после присваиваний
 * и export/env: `git push origin gh-pages -R x` и `echo "gh -R x"` — не gh. В счёт идут:
 *  - env: GH_REPO= через export и в команде из одних присваиваний (в том числе обрезанной перед командой мёржа);
 *  - prs: -R/--repo и URL PR команд `gh pr <что-то>` о том же PR и GH_REPO= перед ними. `gh workflow run -R x` и
 *    `gh pr view 42 -R x` — о другом, не в счёт: cmd2 бывает следующим шагом, а не вариантом мёржа (линза Claude #363).
 * Имя переменной без кавычек: `--body "GH_REPO=x"` и `echo GH_REPO=x` — текст (Контроль #363, п. 1–2).
 */
function scanRepos(cmd: string, pr: number | null): { env: FoundRepos; prs: FoundRepos } {
  const env: FoundRepos = { repos: [], problems: [] }
  const prs: FoundRepos = { repos: [], problems: [] }
  for (const m of cmd.matchAll(SEGMENT)) {
    const raw = commandWords(m[0])
    const words = raw.map(unquote)
    const prefix: FoundRepos = { repos: [], problems: [] }
    let i = 0
    let exported = false
    for (; i < words.length; i++) {
      const w = words[i] ?? ''
      const r = raw[i] ?? ''
      if (w === 'export' || w === 'env') { exported ||= w === 'export'; continue }
      if (!/^[A-Za-z_]\w*=/.test(r)) break
      if (r.startsWith('GH_REPO=')) addRepo(exported ? env : prefix, r.slice(8), w.slice(8), 'GH_REPO=')
    }
    const into = (to: FoundRepos, from: FoundRepos) => { to.repos.push(...from.repos); to.problems.push(...from.problems) }
    if (i >= words.length) { into(env, prefix); continue }
    if (!/(?:^|\/)gh$/.test(words[i] ?? '') || words[i + 1] !== 'pr') continue
    const flags = ghPrFlags(raw, words, i + 2, pr)
    if (flags.same) { into(prs, prefix); into(prs, flags) }
  }
  return { env, prs }
}

/** GH_REPO= для команды мёржа: из строки перед ней (export или присваивания перед самой командой). */
const envRepos = (before: string, pr: number | null): FoundRepos => scanRepos(before, pr).env

/** Репозитории, названные вне команды мёржа о том же PR: GH_REPO= и `gh pr … <pr>` с -R/--repo или URL PR. */
export function looseRepos(cmd: string, pr: number | null): FoundRepos {
  const { env, prs } = scanRepos(cmd, pr)
  return { repos: [...prs.repos, ...env.repos], problems: [...prs.problems, ...env.problems] }
}
