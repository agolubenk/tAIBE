/**
 * Контейнеры в отчёте по compose-проектам (OPS-8). Агент ≥ 1.5 присылает все стеки хоста; без групп строка
 * «все работают» не говорила, какие стеки учтены. Чистая логика, без БД.
 *
 * Карточка отвечает «что работает», а не «что сломано» (это алерты, isContainerDown): не работает любой
 * контейнер не в running, причина остановки не важна — стек, остановленный руками, виден как «t-boards 0/4».
 * Исключение — разовая задача, завершённая кодом 0 (isExpectedExit: migrate, vault-bootstrap): это не сервис,
 * в «всего» она не входит.
 */
import { isExpectedExit } from '../../shared/container-state'
import { plural } from '../../shared/plural'
import type { OpsReport } from '../../shared/report-contract'
import { escapeHtml } from '../notify/format'

type Projects = NonNullable<OpsReport['hosts'][number]['projects']>

/** Сколько стеков и неработающих контейнеров стека называть в карточке — остальное числом. */
const SHOW_STACKS = 6
const SHOW_STOPPED = 3

export function containerProjects(
  list: Array<{ name: string; composeProject: string; mainStack: boolean; state: string; restartPolicy: string; exitCode: number | null }>,
): Projects {
  const by = new Map<string, Projects[number]>()
  for (const c of list) {
    const p = by.get(c.composeProject) ?? { name: c.composeProject, main: false, total: 0, running: 0, stopped: [] }
    p.main ||= c.mainStack
    by.set(c.composeProject, p)
    if (c.state === 'exited' && isExpectedExit(c.restartPolicy, c.exitCode)) continue
    p.total += 1
    if (c.state === 'running') p.running += 1
    else p.stopped.push(c.name)
  }
  return [...by.values()]
    .filter((p) => p.total > 0)
    .sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name))
}

/**
 * Стеки, которые были у хоста в прошлом сохранённом отчёте и пропали (OPS-57). Сравниваются только хосты, у которых
 * в прошлом отчёте были группы (агент ≥ 1.5, отчёт после OPS-8); хост, которого не было, ничего не теряет.
 */
export function missingProjects(
  previous: Pick<OpsReport, 'hosts'> | null,
  agent: string,
  current: Projects,
): string[] {
  const host = previous?.hosts.find((h) => h.agent === agent)
  // A stack stays missing until it returns: the saved report keeps it in missingProjects, not in projects.
  const before = new Set([...(host?.projects ?? []).map((p) => p.name), ...(host?.missingProjects ?? [])])
  if (!before.size) return []
  const now = new Set(current.map((p) => p.name))
  return [...before].filter((name) => !now.has(name))
}

const more = (n: number, forms: readonly [string, string, string]) => (n > 0 ? ` и ещё ${plural(n, forms)}` : '')
const label = (name: string) => name || 'без compose'

/** Хвост строки хоста в подробном отчёте (HTML): стеки «работает/всего» и неработающие; до OPS-8 — только упавшие. */
/** Хост со стеками в отчёте: есть текущие или пропавшие (хост, потерявший все стеки, — худший случай OPS-57). */
const hasStacks = (h: Pick<OpsReport['hosts'][number], 'projects' | 'missingProjects'>) =>
  Boolean(h.projects?.length || h.missingProjects?.length)

export function hostContainers(h: OpsReport['hosts'][number]): string {
  if (!hasStacks(h)) return h.containersNotRunning.length ? ` · не работают: ${escapeHtml(h.containersNotRunning.join(', '))}` : ''
  const stacks = (h.projects ?? []).map((p) => `${label(p.name)} ${p.running}/${p.total}${p.stopped.length ? ` (не работают: ${p.stopped.join(', ')})` : ''}`)
  const gone = h.missingProjects?.length ? gonePhrase(h.missingProjects.map(label)) : ''
  // Хост потерял все стеки: «стеки:» без списка не пишем, остаётся только пропажа.
  return ` · ${escapeHtml([stacks.length ? `стеки: ${stacks.join(', ')}` : '', gone].filter(Boolean).join(' · '))}`
}

/** «пропал стек: t-boards» / «пропали стеки: a, b» — без HTML, экранирует вызывающий. */
function gonePhrase(names: string[]): string {
  return `${names.length > 1 ? 'пропали стеки' : 'пропал стек'}: ${names.slice(0, SHOW_STACKS).join(', ')}${more(names.length - SHOW_STACKS, ['стек', 'стека', 'стеков'])}`
}

/** Строка «📦 Контейнеры: …» карточки отчёта (HTML). Отчёт без групп (до OPS-8) — прежний список упавших. */
export function containersLine(r: Pick<OpsReport, 'hosts' | 'restarts'>): string {
  const withProjects = r.hosts.filter(hasStacks)
  const tail = ` · перезапусков: ${r.restarts.length}`
  if (!withProjects.length) {
    const down = r.hosts.flatMap((h) => h.containersNotRunning.map((c) => `${h.name}/${c}`))
    return `📦 Контейнеры: ${down.length ? `не работают — ${escapeHtml(down.slice(0, 4).join(', '))}${down.length > 4 ? ` и ещё ${down.length - 4}` : ''}` : 'все работают'}${tail}`
  }
  const prefix = withProjects.length > 1
  const stacks = withProjects.flatMap((h) => (h.projects ?? []).map((p) => ({ ...p, label: `${prefix ? `${h.name}/` : ''}${label(p.name)}` })))
  const stopped = stacks.filter((s) => s.stopped.length)
  // Пропавший стек (OPS-57) — тоже не «все работают». «было N» = стеки сейчас + пропавшие: если в тот же день
  // появился новый стек, N больше числа стеков прошлого отчёта.
  const gone = withProjects.flatMap((h) => (h.missingProjects ?? []).map((n) => `${prefix ? `${h.name}/` : ''}${label(n)}`))
  const goneText = gone.length
    ? `${gonePhrase(gone)} (было ${withProjects.reduce((n, h) => n + (h.projects?.length ?? 0) + (h.missingProjects?.length ?? 0), 0)})`
    : ''
  const working = stopped.length
    ? `не работают — ${stopped
        .slice(0, SHOW_STACKS)
        .map((s) => `${s.label}: ${s.stopped.slice(0, SHOW_STOPPED).join(', ')}${more(s.stopped.length - SHOW_STOPPED, ['контейнер', 'контейнера', 'контейнеров'])}`)
        .join('; ')}${more(stopped.length - SHOW_STACKS, ['стек', 'стека', 'стеков'])}`
    : ''
  const state = [goneText, working].filter(Boolean).join('; ') || 'все работают'
  // Стеки с неработающими — первыми: при обрезке до SHOW_STACKS «0/4» не уходит в «и ещё».
  const ordered = [...stopped, ...stacks.filter((s) => !s.stopped.length)]
  const counts = `${ordered
    .slice(0, SHOW_STACKS)
    .map((s) => `${s.label} ${s.running}/${s.total}`)
    .join(', ')}${more(ordered.length - SHOW_STACKS, ['стек', 'стека', 'стеков'])}`
  const summary = stacks.length ? ` · ${plural(stacks.length, ['стек', 'стека', 'стеков'])}: ${escapeHtml(counts)}` : ''
  return `📦 Контейнеры: ${escapeHtml(state)}${summary}${tail}`
}
