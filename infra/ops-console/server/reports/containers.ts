/**
 * Контейнеры в отчёте по compose-проектам (OPS-8). Агент ≥ 1.5 присылает все стеки хоста; без групп строка
 * «все работают» не говорила, какие стеки учтены. Чистая логика, без БД.
 */
import { isContainerDown } from '../../shared/container-state'
import { plural } from '../../shared/plural'
import type { OpsReport } from '../../shared/report-contract'
import { escapeHtml } from '../notify/format'

type Projects = NonNullable<OpsReport['hosts'][number]['projects']>

/** Сколько стеков и упавших контейнеров стека называть в карточке — остальное числом. */
const SHOW_STACKS = 6
const SHOW_DOWN = 3

export function containerProjects(
  list: Array<{ name: string; composeProject: string; mainStack: boolean; state: string; restartPolicy: string; exitCode: number | null }>,
): Projects {
  const by = new Map<string, Projects[number]>()
  for (const c of list) {
    const p = by.get(c.composeProject) ?? { name: c.composeProject, main: false, total: 0, down: [] }
    p.main ||= c.mainStack
    p.total += 1
    if (isContainerDown(c)) p.down.push(c.name)
    by.set(c.composeProject, p)
  }
  return [...by.values()].sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name))
}

const more = (n: number, forms: readonly [string, string, string]) => (n > 0 ? ` и ещё ${plural(n, forms)}` : '')

/** Хвост строки хоста в подробном отчёте (HTML): стеки с числом контейнеров и упавшими; до OPS-8 — только упавшие. */
export function hostContainers(h: OpsReport['hosts'][number]): string {
  if (!h.projects?.length) return h.containersNotRunning.length ? ` · не работают: ${escapeHtml(h.containersNotRunning.join(', '))}` : ''
  const stacks = h.projects.map((p) => `${p.name || 'без compose'} ${p.total}${p.down.length ? ` (не работают: ${p.down.join(', ')})` : ''}`)
  return ` · стеки: ${escapeHtml(stacks.join(', '))}`
}

/** Строка «📦 Контейнеры: …» карточки отчёта (HTML). Отчёт без групп (до OPS-8) — прежний список упавших. */
export function containersLine(r: Pick<OpsReport, 'hosts' | 'restarts'>): string {
  const withProjects = r.hosts.filter((h) => h.projects?.length)
  const tail = ` · перезапусков: ${r.restarts.length}`
  if (!withProjects.length) {
    const down = r.hosts.flatMap((h) => h.containersNotRunning.map((c) => `${h.name}/${c}`))
    return `📦 Контейнеры: ${down.length ? `не работают — ${escapeHtml(down.slice(0, 4).join(', '))}${down.length > 4 ? ` и ещё ${down.length - 4}` : ''}` : 'все работают'}${tail}`
  }
  const prefix = withProjects.length > 1
  const stacks = withProjects.flatMap((h) =>
    (h.projects ?? []).map((p) => ({ ...p, label: `${prefix ? `${h.name}/` : ''}${p.name || 'без compose'}` })),
  )
  const down = stacks.filter((s) => s.down.length)
  const state = down.length
    ? `не работают — ${down
        .slice(0, SHOW_STACKS)
        .map((s) => `${s.label}: ${s.down.slice(0, SHOW_DOWN).join(', ')}${more(s.down.length - SHOW_DOWN, ['контейнер', 'контейнера', 'контейнеров'])}`)
        .join('; ')}${more(down.length - SHOW_STACKS, ['стек', 'стека', 'стеков'])}`
    : 'все работают'
  const counts = `${stacks
    .slice(0, SHOW_STACKS)
    .map((s) => `${s.label} ${s.total}`)
    .join(', ')}${more(stacks.length - SHOW_STACKS, ['стек', 'стека', 'стеков'])}`
  return `📦 Контейнеры: ${escapeHtml(state)} · ${plural(stacks.length, ['стек', 'стека', 'стеков'])}: ${escapeHtml(counts)}${tail}`
}
