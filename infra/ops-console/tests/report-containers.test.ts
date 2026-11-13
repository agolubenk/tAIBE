/** OPS-8: контейнеры в отчёте по compose-проектам — группы, строка карточки, строка хоста, отчёт до OPS-8. OPS-57: пропавший стек. */
import { describe, expect, it } from 'vitest'
import { containerProjects, containersLine, hostContainers, missingProjects } from '../server/reports/containers'
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
type Stack = NonNullable<Host['projects']>[number]
const host = (name: string, projects?: Stack[], containersNotRunning: string[] = []): Host => ({
  agent: name,
  name,
  cpuAvgPct: null,
  cpuMaxPct: null,
  memAvgPct: null,
  diskMaxPct: null,
  containersNotRunning,
  ...(projects ? { projects } : {}),
})
const stack = (name: string, total: number, stopped: string[] = [], main = false): Stack => ({ name, main, total, running: total - stopped.length, stopped })

describe('контейнеры отчёта по стекам (OPS-8)', () => {
  it('группы: стек продукта первым; не running — не работает при любой причине; разовая задача с кодом 0 не считается', () => {
    const p = containerProjects([
      ctr('tb-api-1', 't-boards', { state: 'restarting' }),
      ctr('tb-web-1', 't-boards', { state: 'exited', code: 143 }),
      ctr('backend-api-1', 'backend'),
      ctr('backend-worker-1', 'backend', { state: 'exited', code: 1 }),
      ctr('vault-bootstrap-1', 'backend', { state: 'exited', policy: 'no', code: 0 }),
      ctr('council-1', 'ai-council', { state: 'paused' }),
      ctr('once', 'jobs', { main: false, state: 'exited', policy: 'no', code: 0 }),
    ])
    expect(p).toEqual([
      { name: 'backend', main: true, total: 2, running: 1, stopped: ['backend-worker-1'] },
      { name: 'ai-council', main: false, total: 1, running: 0, stopped: ['council-1'] },
      { name: 't-boards', main: false, total: 2, running: 0, stopped: ['tb-api-1', 'tb-web-1'] },
    ])
  })

  it('стек, остановленный руками (exited 143, unless-stopped), — «0/4», не «все работают»', () => {
    const p = containerProjects([
      ctr('backend-api-1', 'backend'),
      ...['api', 'web', 'mcp', 'db'].map((s) => ctr(`tb-${s}-1`, 't-boards', { state: 'exited', code: 143 })),
    ])
    const line = containersLine({ hosts: [host('prod', p)], restarts: [] })
    expect(line).not.toContain('все работают')
    expect(line).toBe('📦 Контейнеры: не работают — t-boards: tb-api-1, tb-web-1, tb-mcp-1 и ещё 1 контейнер · 2 стека: t-boards 0/4, backend 1/1 · перезапусков: 0')
  })

  it('карточка: все работают — стеки «работает/всего»', () => {
    const projects = [stack('backend', 22, [], true), stack('ai-council', 2), stack('headroom', 1), stack('t-boards', 4)]
    expect(containersLine({ hosts: [host('prod', projects)], restarts: [] })).toBe(
      '📦 Контейнеры: все работают · 4 стека: backend 22/22, ai-council 2/2, headroom 1/1, t-boards 4/4 · перезапусков: 0',
    )
  })

  it('карточка: лишнее числом, стеки со сбоем не уходят в «и ещё»; несколько хостов — с именем хоста; HTML экранирован', () => {
    const many = Array.from({ length: 8 }, (_, i) => stack(`s${i}`, 1))
    many[0] = stack('s0', 5, ['a', 'b', 'c', 'd', 'e'])
    many[7] = stack('s7', 1, ['<x>'])
    const line = containersLine({ hosts: [host('prod', many), host('dev', [stack('backend', 3, [], true)])], restarts: [] })
    expect(line).toContain('не работают — prod/s0: a, b, c и ещё 2 контейнера; prod/s7: &lt;x&gt;')
    expect(line).toContain('· 9 стеков: prod/s0 0/5, prod/s7 0/1, prod/s1 1/1, prod/s2 1/1, prod/s3 1/1, prod/s4 1/1 и ещё 3 стека')
    expect(line).not.toContain('<x>')
  })

  it('отчёт до OPS-8 (без projects) — прежняя строка', () => {
    expect(containersLine({ hosts: [host('prod', undefined, ['worker'])], restarts: [] })).toBe('📦 Контейнеры: не работают — prod/worker · перезапусков: 0')
    expect(containersLine({ hosts: [host('prod')], restarts: [] })).toBe('📦 Контейнеры: все работают · перезапусков: 0')
  })

  it('подробный отчёт: строка хоста «работает/всего»; до OPS-8 — только упавшие', () => {
    expect(hostContainers(host('prod', [stack('backend', 2, ['w'], true), stack('', 1)]))).toBe(' · стеки: backend 1/2 (не работают: w), без compose 1/1')
    expect(hostContainers(host('prod', undefined, ['w']))).toBe(' · не работают: w')
    expect(hostContainers(host('prod'))).toBe('')
  })
})

describe('пропавший стек (OPS-57)', () => {
  const now = [stack('backend', 2, [], true)]

  it('сравнивает с прошлым отчётом только хосты, у которых там были стеки', () => {
    const prev = { hosts: [host('prod', [stack('backend', 2, [], true), stack('t-boards', 4)]), host('old', undefined, [])] }
    expect(missingProjects(prev, 'prod', now)).toEqual(['t-boards'])
    expect(missingProjects(prev, 'old', now)).toEqual([])
    expect(missingProjects(prev, 'new', now)).toEqual([])
    expect(missingProjects(null, 'prod', now)).toEqual([])
    expect(missingProjects(prev, 'prod', [...now, stack('t-boards', 4, ['a', 'b', 'c', 'd'])])).toEqual([])
  })

  it('пропавший стек числится пропавшим, пока не вернётся: прошлый отчёт держит его в missingProjects', () => {
    const prev = { hosts: [{ ...host('prod', now), missingProjects: ['t-boards'] }] }
    expect(missingProjects(prev, 'prod', now)).toEqual(['t-boards'])
    expect(missingProjects(prev, 'prod', [...now, stack('t-boards', 2)])).toEqual([])
    // Хост потерял все стеки: projects пуст, пропавшие всё равно сравниваются; повтор имени не двоится.
    const empty = { hosts: [{ ...host('prod', []), missingProjects: ['backend', 't-boards'] }] }
    expect(missingProjects(empty, 'prod', [])).toEqual(['backend', 't-boards'])
    const both = { hosts: [{ ...host('prod', now), missingProjects: ['backend'] }] }
    expect(missingProjects(both, 'prod', [])).toEqual(['backend'])
  })

  it('пропал стек — карточка не пишет «все работают», хост называет его', () => {
    const h = { ...host('prod', now), missingProjects: ['t-boards'] }
    expect(containersLine({ hosts: [h], restarts: [] })).toBe(
      '📦 Контейнеры: пропал стек: t-boards (было 2) · 1 стек: backend 2/2 · перезапусков: 0',
    )
    expect(hostContainers(h)).toBe(' · стеки: backend 2/2 · пропал стек: t-boards')
  })

  it('пропавший и неработающий — оба в строке; несколько хостов — с именем хоста', () => {
    const a = { ...host('a', [stack('backend', 2, ['w'], true)]), missingProjects: ['t-boards', ''] }
    const b = host('b', [stack('x', 1)])
    expect(containersLine({ hosts: [a, b], restarts: [] })).toBe(
      '📦 Контейнеры: пропали стеки: a/t-boards, a/без compose (было 4); не работают — a/backend: w · 2 стека: a/backend 1/2, b/x 1/1 · перезапусков: 0',
    )
  })
})
