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

const REPO = /^[\w.-]+\/[\w.-]+$/
/** Любая команда gh до разделителя — то же правило слов и перенаправлений, что у GH_PR. */
const GH_ANY = /\bgh\b(?:\\[\s\S]|[<>]&|&>|[^\n;&|"'\\]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')*/g
const repoOf = (v: string): string | null => {
  const name = repoName(v.split(/[;&|)]/)[0] ?? '')
  return REPO.test(name) ? name : null
}
/**
 * Репозитории из -R/--repo любой команды gh строки (не только команды мёржа) и из GH_REPO= — по словам shell: «-R x/y»
 * внутри значения в кавычках (`--body "see -R x/y"`) — текст, а не флаг; `cp -R a/b c/` — не gh. Не похожее на
 * `owner/name` не берётся; хвост `;gh …` без пробела у GH_REPO= отрезается.
 */
export function looseRepos(cmd: string): string[] {
  const out: string[] = []
  for (const m of cmd.matchAll(GH_ANY)) {
    const words = commandWords(m[0]).map(unquote)
    for (let i = 1; i < words.length; i++) {
      const w = words[i] ?? ''
      const v = w === '-R' || w === '--repo' ? (words[++i] ?? '') : (/^(?:-R=?|--repo=)(\S+)$/.exec(w)?.[1] ?? '')
      const name = repoOf(v)
      if (name) out.push(name)
    }
  }
  for (const w of commandWords(cmd).map(unquote)) {
    const name = w.startsWith('GH_REPO=') ? repoOf(w.slice('GH_REPO='.length)) : null
    if (name) out.push(name)
  }
  return out
}
