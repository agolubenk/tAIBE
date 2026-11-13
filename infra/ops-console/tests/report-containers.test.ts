/** OPS-8: контейнеры в отчёте по compose-проектам — группы, строка карточки, строка хоста, отчёт до OPS-8. */
import { describe, expect, it } from 'vitest'
import { containerProjects, containersLine, hostContainers } from '../server/reports/containers'
import type { OpsReport } from '../shared/report-contract'

const ctr = (name: string, composeProject: string, o: { main?: boolean; state?: string; policy?: string; code?: number | null } = {}) => ({
  name,
  composeProject,
  mainStack: o.main ?? composeProject === 'backend',
  state: o.state ?? 'running',
  restartPolicy: o.policy ?? 'unless-stopped',
  exitCode: o.code ?? null,
})

type Host = OpsReport['hosts'][number]
const host = (name: string, projects?: Host['projects'], containersNotRunning: string[] = []): Host => ({
  agent: name,
  name,
  cpuAvgPct: null,
  cpuMaxPct: null,
  memAvgPct: null,
  diskMaxPct: null,
  containersNotRunning,
  ...(projects ? { projects } : {}),
})

describe('контейнеры отчёта по стекам (OPS-8)', () => {
  it('группы: стек продукта первым, остальные по имени; «упал» — по правилу соседнего стека', () => {
    const p = containerProjects([
      ctr('tb-api-1', 't-boards', { state: 'restarting' }),
      ctr('backend-api-1', 'backend'),
      ctr('backend-worker-1', 'backend', { state: 'exited', code: 1 }),
      ctr('headroom-1', 'headroom', { state: 'exited', code: 143 }),
      ctr('council-1', 'ai-council'),
      ctr('probe', '', { main: false, state: 'exited', policy: 'no', code: 0 }),
    ])
    expect(p).toEqual([
      { name: 'backend', main: true, total: 2, down: ['backend-worker-1'] },
      { name: '', main: false, total: 1, down: [] },
      { name: 'ai-council', main: false, total: 1, down: [] },
      { name: 'headroom', main: false, total: 1, down: [] },
      { name: 't-boards', main: false, total: 1, down: ['tb-api-1'] },
    ])
  })

  it('карточка: все работают — стеки с числом контейнеров', () => {
    const projects = [
      { name: 'backend', main: true, total: 22, down: [] },
      { name: 'ai-council', main: false, total: 2, down: [] },
      { name: 'headroom', main: false, total: 1, down: [] },
      { name: 't-boards', main: false, total: 4, down: [] },
    ]
    expect(containersLine({ hosts: [host('prod', projects)], restarts: [] })).toBe(
      '📦 Контейнеры: все работают · 4 стека: backend 22, ai-council 2, headroom 1, t-boards 4 · перезапусков: 0',
    )
  })

  it('карточка: упавшие по стекам, лишнее числом; несколько хостов — с именем хоста; HTML экранирован', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, main: false, total: 1, down: [] as string[] }))
    many[0]!.down = ['a', 'b', 'c', 'd', 'e']
    many[1]!.down = ['<x>']
    const line = containersLine({ hosts: [host('prod', many), host('dev', [{ name: 'backend', main: true, total: 3, down: [] }])], restarts: [] })
    expect(line).toContain('не работают — prod/s0: a, b, c и ещё 2 контейнера; prod/s1: &lt;x&gt;')
    expect(line).toContain('· 9 стеков: prod/s0 1, prod/s1 1, prod/s2 1, prod/s3 1, prod/s4 1, prod/s5 1 и ещё 3 стека')
    expect(line).not.toContain('<x>')
  })

  it('отчёт до OPS-8 (без projects) — прежняя строка', () => {
    expect(containersLine({ hosts: [host('prod', undefined, ['worker'])], restarts: [] })).toBe('📦 Контейнеры: не работают — prod/worker · перезапусков: 0')
    expect(containersLine({ hosts: [host('prod')], restarts: [] })).toBe('📦 Контейнеры: все работают · перезапусков: 0')
  })

  it('подробный отчёт: строка хоста по стекам; до OPS-8 — только упавшие', () => {
    expect(hostContainers(host('prod', [{ name: 'backend', main: true, total: 2, down: ['w'] }, { name: '', main: false, total: 1, down: [] }]))).toBe(
      ' · стеки: backend 2 (не работают: w), без compose 1',
    )
    expect(hostContainers(host('prod', undefined, ['w']))).toBe(' · не работают: w')
    expect(hostContainers(host('prod'))).toBe('')
  })
})
