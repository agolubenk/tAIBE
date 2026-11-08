/**
 * Версия продукта (APP-558): формат, сравнение и шаг версии; класс коммита (merge PR, форма с двоеточием, squash,
 * свой merge); привязка к SHA деплоя (успех, новее ручной, упавший, идущий, перезапуск, not_started не в счёт, деплоев
 * нет); PUT — только владелец, 409 на чужую ревизию, новый деплой и новый ручной запуск, 400 на понижение без
 * подтверждения; хранилище (длинный автор, копия битой строки); один опрос GitHub; подвал; предложение отдельно и
 * пошаговым обходом; публичный ответ без sha, автора и заметки, кэш 60 с.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { settings, users } from '../server/db/schema'
import { hashPassword } from '../server/lib/crypto'
import * as http from '../server/lib/http'
import { writeSetting } from '../server/settings/store'
import { tryAcquireLease } from '../server/scheduler/lease'
import { MANUAL_RUN_TITLE, NOT_STARTED } from '../server/deploys/github'
import { syncGithubDeploysOnce } from '../server/deploys/sync-once'
import { computeBinding, type DeployRow } from '../server/release/binding'
import { nextReleaseState, readRelease, RELEASE_BACKUP_KEY, RELEASE_KEY, writeRelease } from '../server/release/store'
import { classifyCommit } from '../server/release/suggest'
import {
  bumpReleaseVersion,
  compareReleaseVersions,
  formatReleaseVersion,
  parseReleaseVersion,
  RELEASE_VERSION_RE,
  type ReleaseTuple,
} from '../shared/release'

const t = (v: string): ReleaseTuple => {
  const r = parseReleaseVersion(v)
  if (!r) throw new Error(`bad version ${v}`)
  return r
}

describe('формат, сравнение и шаг версии', () => {
  it('регулярное выражение: четыре сегмента 0–9999 без ведущих нулей', () => {
    for (const ok of ['v.0.0.0.0', 'v.0.1.0.0', 'v.9999.9999.9999.9999', 'v.1.20.300.4000']) expect(RELEASE_VERSION_RE.test(ok)).toBe(true)
    for (const bad of ['0.1.0.0', 'v0.1.0.0', 'v.0.1.0', 'v.0.1.0.0.0', 'v.01.0.0.0', 'v.10000.0.0.0', 'v.-1.0.0.0', 'v.0.1.0.0 ', 'V.0.1.0.0', 'v.0.1.a.0']) {
      expect(RELEASE_VERSION_RE.test(bad)).toBe(false)
    }
    expect(parseReleaseVersion('v.0.12.3.4')).toEqual([0, 12, 3, 4])
    expect(parseReleaseVersion('v.0.012.3.4')).toBeNull()
    expect(formatReleaseVersion([0, 2, 0, 0])).toBe('v.0.2.0.0')
  })

  it('сравнение — по сегментам, не по строке', () => {
    expect(compareReleaseVersions(t('v.0.2.0.0'), t('v.0.1.9999.9999'))).toBeGreaterThan(0)
    expect(compareReleaseVersions(t('v.0.10.0.0'), t('v.0.9.0.0'))).toBeGreaterThan(0)
    expect(compareReleaseVersions(t('v.1.0.0.0'), t('v.0.9999.0.0'))).toBeGreaterThan(0)
    expect(compareReleaseVersions(t('v.0.1.0.0'), t('v.0.1.0.1'))).toBeLessThan(0)
    expect(compareReleaseVersions(t('v.0.1.2.3'), t('v.0.1.2.3'))).toBe(0)
  })

  it('один шаг на выпуск: feature → B+1, иначе fix → C+1, иначе D+1; A не меняется', () => {
    const cur = t('v.3.1.2.3')
    expect(bumpReleaseVersion(cur, ['fix', 'feature', 'other'])).toEqual([3, 2, 0, 0])
    expect(bumpReleaseVersion(cur, ['other', 'fix', 'fix'])).toEqual([3, 1, 3, 0])
    expect(bumpReleaseVersion(cur, ['other', 'other'])).toEqual([3, 1, 2, 4])
    expect(bumpReleaseVersion(cur, [])).toBeNull()
  })

  it('сегмент больше 9999 — предложения нет', () => {
    expect(bumpReleaseVersion(t('v.0.9999.5.5'), ['feature'])).toBeNull()
    expect(bumpReleaseVersion(t('v.0.1.9999.0'), ['fix'])).toBeNull()
    expect(bumpReleaseVersion(t('v.0.1.0.9999'), ['other'])).toBeNull()
    expect(bumpReleaseVersion(t('v.0.1.9999.0'), ['feature'])).toEqual([0, 2, 0, 0])
  })
})

describe('класс коммита', () => {
  it('merge PR — по префиксу ветки', () => {
    expect(classifyCommit('Merge pull request #541 from agolubenk/feature/roadmap-version\n\nfeat: x')).toBe('feature')
    expect(classifyCommit('Merge pull request #17 from agolubenk/feat/quick')).toBe('feature')
    expect(classifyCommit('Merge pull request #530 from agolubenk/fix/gmail-scope')).toBe('fix')
    expect(classifyCommit('Merge pull request #400 from agolubenk/docs/plans')).toBe('other')
    expect(classifyCommit('Merge pull request #401 from agolubenk/dependabot/npm_and_yarn/vite-6')).toBe('other')
  })

  it('форма с двоеточием «from owner:branch»', () => {
    expect(classifyCommit('Merge pull request #300 from agolubenk:refactor/relaunch-sync')).toBe('other')
    expect(classifyCommit('Merge pull request #301 from agolubenk:fix/relaunch')).toBe('fix')
    expect(classifyCommit('Merge pull request #302 from agolubenk:feature/relaunch')).toBe('feature')
  })

  it('squash и прямой коммит — по conventional-заголовку', () => {
    expect(classifyCommit('feat(roadmap): APP-545 — содержимое /roadmap (#541)')).toBe('feature')
    expect(classifyCommit('feat!: несовместимое')).toBe('feature')
    expect(classifyCommit('fix(google): Gmail убран (#533) [skip ci]')).toBe('fix')
    expect(classifyCommit('fix: опечатка\n\nfeat: в теле не считается')).toBe('fix')
    expect(classifyCommit('docs(plans): журнал')).toBe('other')
    expect(classifyCommit('feature: не conventional')).toBe('other')
  })

  it('свой merge без ветки — прочее', () => {
    expect(classifyCommit('Merge pull request #448 [skip ci]')).toBe('other')
    expect(classifyCommit('merge: main into feature/roadmap')).toBe('other')
    expect(classifyCommit("Merge branch 'main' into fix/x")).toBe('other')
  })
})

const row = (runKey: string, o: Partial<DeployRow> = {}): DeployRow => ({
  id: Number(runKey),
  runKey,
  workflow: 'deploy-contabo.yml',
  status: 'completed',
  conclusion: 'success',
  headSha: `${runKey.padStart(4, '0')}aaaabbbb`,
  title: `Merge pull request #${runKey} from o/feature/x`,
  actor: 'dev',
  url: `https://github.com/o/r/actions/runs/${runKey}`,
  startedAt: new Date(1_000_000),
  finishedAt: new Date(1_060_000),
  createdAt: new Date(1_000_000),
  ...o,
})

describe('привязка к SHA деплоя', () => {
  it('успех: последний успешный не ручной по номеру запуска, а не по строке', () => {
    const b = computeBinding([row('9'), row('10'), row('8', { conclusion: 'failure' })])
    expect(b).toMatchObject({ mode: 'auto', sha: row('10').headSha, run: { runKey: '10', url: row('10').url } })
  })

  it('новее — ручной запуск любого статуса: SHA вставляет владелец', () => {
    for (const manual of [{}, { conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) {
      const b = computeBinding([row('5'), row('6', { title: MANUAL_RUN_TITLE, ...manual })])
      expect(b).toMatchObject({ mode: 'confirm', reason: 'manual_run', sha: row('5').headSha, run: { runKey: '6', url: row('6').url } })
    }
  })

  it('новее — упавший, таймаут или отменённый запуск', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
      expect(computeBinding([row('5'), row('6', { conclusion })])).toMatchObject({ mode: 'confirm', reason: 'failed_run', run: { runKey: '6' } })
    }
  })

  it('новее — идущий или в очереди', () => {
    for (const status of ['in_progress', 'queued']) {
      expect(computeBinding([row('5'), row('6', { status, conclusion: null })])).toMatchObject({ mode: 'confirm', reason: 'in_progress', sha: row('5').headSha })
    }
  })

  it('not_started и skipped прод не меняли — не в счёт, и у ручного тоже', () => {
    const b = computeBinding([
      row('5'),
      row('6', { conclusion: NOT_STARTED }),
      row('7', { conclusion: 'skipped' }),
      row('8', { title: MANUAL_RUN_TITLE, conclusion: NOT_STARTED }),
    ])
    expect(b).toMatchObject({ mode: 'auto', sha: row('5').headSha })
  })

  it('перезапуск старого запуска после более нового успешного — новее него', () => {
    const late = { startedAt: new Date(2_000_000), createdAt: new Date(900_000) }
    expect(computeBinding([row('5', { ...late, status: 'in_progress', conclusion: null }), row('6')])).toMatchObject({
      mode: 'confirm',
      reason: 'in_progress',
      sha: row('6').headSha,
      run: { runKey: '5' },
    })
    expect(computeBinding([row('5', { ...late, conclusion: 'failure' }), row('6')])).toMatchObject({ mode: 'confirm', reason: 'failed_run', run: { runKey: '5' } })
    // Успешный перезапуск выкатил старый коммит заново: на проде он.
    expect(computeBinding([row('5', late), row('6')])).toMatchObject({ mode: 'auto', sha: row('5').headSha, run: { runKey: '5' } })
  })

  it('деплоев нет — no_deploy; ручной успех — не база', () => {
    expect(computeBinding([])).toEqual({ mode: 'confirm', reason: 'no_deploy', sha: null, run: null })
    expect(computeBinding([row('3', { conclusion: NOT_STARTED })])).toMatchObject({ mode: 'confirm', reason: 'no_deploy', sha: null })
    expect(computeBinding([row('3', { title: MANUAL_RUN_TITLE })])).toMatchObject({ mode: 'confirm', reason: 'manual_run', sha: null })
  })
})

// ── HTTP: GitHub подменён ─────────────────────────────────────────────────────

const sha40 = (n: number) => `${n.toString(16).padStart(8, '0')}${'c'.repeat(32)}`
const OLD = new Date(Date.now() - 2 * 3_600_000).toISOString()

type Run = Record<string, unknown>
function ghRun(id: number, o: { conclusion?: string | null; status?: string; event?: string; title?: string } = {}): Run {
  const title = o.title ?? `Merge pull request #${id} from agolubenk/feature/x`
  return {
    id,
    status: o.status ?? 'completed',
    conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
    head_sha: sha40(id),
    head_branch: 'main',
    event: o.event ?? 'push',
    display_title: title,
    head_commit: { message: title },
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    run_started_at: OLD,
    updated_at: OLD,
    actor: { login: 'dev' },
  }
}

type GhCommit = { sha: string; commit: { message: string }; parents: Array<{ sha: string }> }
const commit = (sha: string, message: string, parent: string | null): GhCommit => ({ sha, commit: { message }, parents: parent ? [{ sha: parent }] : [] })

let app: Awaited<ReturnType<typeof freshApp>>
let spy: MockInstance<typeof http.httpRequest>
let runs: Run[]
let commitPages: GhCommit[][]
let commitsStatus: number
let commitCalls: string[]

const reply = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(body), latencyMs: 1 })

beforeEach(async () => {
  app = await freshApp()
  runs = []
  commitPages = []
  commitsStatus = 200
  commitCalls = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url) => {
    if (url.includes('/actions/workflows/')) return reply(200, { workflow_runs: [...runs].reverse() })
    if (url.includes('/jobs')) return reply(200, { jobs: [] })
    if (url.includes('/commits?')) {
      commitCalls.push(url)
      const page = Number(new URL(url).searchParams.get('page'))
      return commitsStatus === 200 ? reply(200, commitPages[page - 1] ?? []) : reply(commitsStatus, { message: 'rate limited' })
    }
    throw new Error(`unexpected request ${url}`)
  })
})
afterEach(() => spy.mockRestore())

async function asRole(role: 'operator' | 'viewer') {
  const email = `${role}@ops.test`
  await getDb().insert(users).values({ email, name: role, role, passwordHash: await hashPassword(`${role}-password-1`), createdAt: new Date() })
  return api(app, await login(app, email, `${role}-password-1`))
}

type Api = ReturnType<typeof api>
const SHA1 = sha40(1).slice(0, 12)
/** Привязка к запуску 1 — то, что видел владелец, когда деплой один. */
const AUTO1 = { expectedMode: 'auto', expectedRunKey: '1', expectedSha: SHA1 }
const put = (o: Api, body: Record<string, unknown>) => o.put('/release', { note: '', ...body })
/** То, что панель шлёт из своего чтения. */
async function seenBy(o: Api) {
  const b = (await o.get('/release')).json
  return { expectedRev: b.rev, expectedMode: b.binding.mode, expectedRunKey: b.binding.run?.runKey ?? '', expectedSha: b.binding.sha ?? '' }
}
/** Отметка опроса старше 150 с: следующее чтение оператора снова спросит GitHub. */
const staleSync = () => writeSetting('deploy_sync', { at: 0, ok: true, error: '' })
const polls = () => spy.mock.calls.filter(([url]) => url.includes('/actions/workflows/')).length

describe('PUT /api/release', () => {
  it('первая версия привязывается к последнему успешному деплою; запись в ленте', async () => {
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    const g = await owner.get('/release')
    expect(g.status).toBe(200)
    expect(g.json).toMatchObject({ rev: 0, current: null, history: [], binding: { mode: 'auto', sha: SHA1, run: { runKey: '1' } } })
    expect(g.json).not.toHaveProperty('suggestion')
    const r = await put(owner, { version: 'v.0.1.0.0', note: 'первая', expectedRev: 0, ...AUTO1 })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ rev: 1, current: { version: 'v.0.1.0.0', sha: SHA1, setBy: 'owner@ops.test', note: 'первая' } })
    const log = await getDb().query.activity.findMany()
    expect(log.some((a) => a.kind === 'config' && a.route === '/deploys' && a.message.includes('v.0.1.0.0'))).toBe(true)
  })

  it('не владельцу — 403 на запись и на предложение', async () => {
    runs = [ghRun(1)]
    for (const role of ['operator', 'viewer'] as const) {
      const other = await asRole(role)
      expect((await other.get('/release')).status).toBe(200)
      expect((await other.get('/release/suggestion')).status).toBe(403)
      expect((await put(other, { version: 'v.0.1.0.0', expectedRev: 0, ...AUTO1 })).status).toBe(403)
    }
    expect(await getDb().query.activity.findMany({ where: (a, { eq }) => eq(a.kind, 'config') })).toEqual([])
  })

  it('чужая ревизия — 409; история — прежние версии, новые сверху', async () => {
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    expect((await put(owner, { version: 'v.0.1.0.0', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    expect((await put(owner, { version: 'v.0.2.0.0', expectedRev: 0, ...AUTO1 })).status).toBe(409)
    expect((await put(owner, { version: 'v.0.2.0.0', expectedRev: 1, ...AUTO1 })).status).toBe(200)
    expect((await put(owner, { version: 'v.0.3.0.0', expectedRev: 2, ...AUTO1 })).status).toBe(200)
    const g = await owner.get('/release')
    expect(g.json).toMatchObject({ rev: 3, current: { version: 'v.0.3.0.0' } })
    expect(g.json.history.map((h: { version: string }) => h.version)).toEqual(['v.0.2.0.0', 'v.0.1.0.0'])
  })

  it('новый деплой между чтением и сохранением — 409, версия не записана', async () => {
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    const seen = await seenBy(owner)
    runs = [ghRun(1), ghRun(2)]
    const r = await put(owner, { version: 'v.0.1.0.0', ...seen })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/Новый деплой/)
    const g = await owner.get('/release')
    expect(g.json.current).toBeNull()
    expect(g.json.binding.sha).toBe(sha40(2).slice(0, 12))
  })

  it('та же или ниже — 400 без подтверждения, с подтверждением — сохраняется', async () => {
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    expect((await put(owner, { version: 'v.0.2.0.0', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    expect((await put(owner, { version: 'v.0.1.9.9', expectedRev: 1, ...AUTO1 })).status).toBe(400)
    expect((await put(owner, { version: 'v.0.2.0.0', expectedRev: 1, ...AUTO1 })).status).toBe(400)
    expect((await put(owner, { version: 'v.0.1.9.9', expectedRev: 1, ...AUTO1, confirmLower: true })).status).toBe(200)
    expect((await put(owner, { version: 'v.0.02.0.0', expectedRev: 2, ...AUTO1 })).status).toBe(400)
    expect((await put(owner, { version: 'v.0.3.0.0', expectedRev: 2, ...AUTO1, note: 'x'.repeat(501) })).status).toBe(400)
  })

  it('новее успешного — ручной запуск: без SHA — 400, вставленный SHA сохраняется', async () => {
    runs = [ghRun(1), ghRun(2, { event: 'workflow_dispatch' })]
    const owner = api(app, await login(app))
    const seen = await seenBy(owner)
    expect(seen).toEqual({ expectedRev: 0, expectedMode: 'confirm', expectedRunKey: '2', expectedSha: SHA1 })
    const base = { version: 'v.0.1.0.0', ...seen }
    expect((await put(owner, base)).status).toBe(400)
    expect((await put(owner, { ...base, sha: 'xyz1234' })).status).toBe(400)
    const r = await put(owner, { ...base, sha: 'ABCDEF1234' })
    expect(r.status).toBe(200)
    expect(r.json.current.sha).toBe('abcdef1234')
  })

  it('подтверждение: ещё один ручной запуск до сохранения — 409 (SHA последнего успешного тот же)', async () => {
    runs = [ghRun(1), ghRun(2, { event: 'workflow_dispatch' })]
    const owner = api(app, await login(app))
    const seen = await seenBy(owner)
    runs = [ghRun(1), ghRun(2, { event: 'workflow_dispatch' }), ghRun(3, { event: 'workflow_dispatch' })]
    const r = await put(owner, { version: 'v.0.1.0.0', ...seen, sha: 'abcdef1' })
    expect(r.status).toBe(409)
    expect((await owner.get('/release')).json).toMatchObject({ current: null, binding: { mode: 'confirm', sha: SHA1, run: { runKey: '3' } } })
  })

  it('битая строка версии: копия в release:hr-helper:backup и запись в ленте, затем новая версия', async () => {
    const raw = '{"rev": 3, "current": "битая'
    await getDb().insert(settings).values({ key: RELEASE_KEY, value: raw, updatedAt: new Date() })
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    expect((await owner.get('/release')).json).toMatchObject({ rev: 0, current: null })
    expect((await put(owner, { version: 'v.0.1.0.0', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    const backup = await getDb().query.settings.findFirst({ where: (st, { eq }) => eq(st.key, RELEASE_BACKUP_KEY) })
    expect(backup?.value).toBe(raw)
    const log = await getDb().query.activity.findMany({ where: (a, { eq }) => eq(a.kind, 'config') })
    expect(log.map((a) => a.message)).toContain(`Повреждённая запись версии сохранена в ${RELEASE_BACKUP_KEY}`)
    expect((await readRelease()).state.current?.version).toBe('v.0.1.0.0')
  })
})

describe('хранилище версии', () => {
  it('автор до 320 знаков сохраняется и читается; длиннее — запись не уходит', async () => {
    const entry = { version: 'v.0.1.0.0', sha: SHA1, setAt: 1, note: '' }
    const setBy = `${'a'.repeat(191)}@ops.test`
    expect(setBy).toHaveLength(200)
    const snap = await readRelease()
    expect(await writeRelease(snap, nextReleaseState(snap.state, { ...entry, setBy }))).toBe(true)
    const back = await readRelease()
    expect(back.state.current?.setBy).toBe(setBy)
    await expect(writeRelease(back, nextReleaseState(back.state, { ...entry, setBy: 'a'.repeat(321) }))).rejects.toThrow(/не прошла проверку/)
    expect((await readRelease()).state.rev).toBe(1)
  })
})

describe('опрос GitHub при чтении', () => {
  it('параллельные вызовы — один опрос; аренда занята — пропуск без ошибки', async () => {
    runs = [ghRun(1)]
    expect(await Promise.all([syncGithubDeploysOnce(), syncGithubDeploysOnce()])).toEqual(['ok', 'ok'])
    expect(polls()).toBe(1)
    expect(await tryAcquireLease('github-sync', 60_000)).toBe(true)
    expect(await syncGithubDeploysOnce()).toBe('busy')
    expect(polls()).toBe(1)
  })

  it('опрашивает оператор и выше, наблюдатель — нет; подвал — без опроса, только версия и SHA', async () => {
    runs = [ghRun(1)]
    const viewer = await asRole('viewer')
    expect((await viewer.get('/release')).json.binding).toMatchObject({ mode: 'confirm', reason: 'no_deploy' })
    expect(polls()).toBe(0)
    const owner = api(app, await login(app))
    expect((await owner.get('/release')).json.binding).toMatchObject({ mode: 'auto', sha: SHA1 })
    expect(polls()).toBe(1)
    await staleSync()
    expect((await owner.get('/release?view=nav')).json).toEqual({ version: null, sha: null })
    expect((await put(owner, { version: 'v.0.1.0.0', note: 'n', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    expect(polls()).toBe(2)
    expect((await viewer.get('/release?view=nav')).json).toEqual({ version: 'v.0.1.0.0', sha: SHA1 })
    expect(polls()).toBe(2)
  })
})

describe('предложение версии', () => {
  async function withCurrent() {
    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    expect((await put(owner, { version: 'v.0.1.2.3', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    await deploy(owner, 2)
    return owner
  }
  /** Новый успешный деплой: чтение панели приносит его из GitHub. */
  async function deploy(owner: Api, id: number) {
    runs = [...runs, ghRun(id)]
    await staleSync()
    expect((await owner.get('/release')).json.binding).toMatchObject({ mode: 'auto', sha: sha40(id).slice(0, 12) })
  }
  const suggest = async (o: Api) => (await o.get('/release/suggestion')).json

  it('по первой родительской линии от деплоя до текущей версии: feature и fix → B+1; кэш', async () => {
    const owner = await withCurrent()
    commitPages = [
      [
        commit(sha40(2), 'Merge pull request #12 from agolubenk/feature/x', sha40(20)),
        commit(sha40(99), 'feat: коммит ветки PR — не первая родительская линия', sha40(1)),
        commit(sha40(20), 'fix(api): squash (#11)', sha40(1)),
        commit(sha40(1), 'Merge pull request #10 from agolubenk/fix/y', sha40(0)),
      ],
    ]
    expect(await suggest(owner)).toEqual({
      suggestion: { version: 'v.0.2.0.0', base: SHA1, head: sha40(2).slice(0, 12), commits: 2, counts: { feature: 1, fix: 1, other: 0 } },
      suggestionError: null,
    })
    expect(commitCalls[0]).toContain(`sha=${sha40(2).slice(0, 12)}`)
    expect(commitCalls[0]).toContain('per_page=100')
    await suggest(owner)
    expect(commitCalls).toHaveLength(1)
  })

  it('пошаговый обход: новый head — одна страница до прошлого head; прошлого head нет на линии — полный обход', async () => {
    const owner = await withCurrent()
    commitPages = [[commit(sha40(2), 'feat: a', sha40(20)), commit(sha40(20), 'chore: b', sha40(1)), commit(sha40(1), 'x', null)]]
    expect((await suggest(owner)).suggestion).toMatchObject({ commits: 2, counts: { feature: 1, fix: 0, other: 1 } })
    await deploy(owner, 3)
    // Без пошагового обхода эта страница не дошла бы до base: у коммита 2 нет родителя на ней.
    commitPages = [[commit(sha40(3), 'fix: c', sha40(2)), commit(sha40(2), 'feat: a', sha40(20))]]
    expect((await suggest(owner)).suggestion).toMatchObject({ head: sha40(3).slice(0, 12), commits: 3, counts: { feature: 1, fix: 1, other: 1 } })
    expect(commitCalls).toHaveLength(2)
    expect(commitCalls[1]).toContain(`sha=${sha40(3).slice(0, 12)}`)
    await deploy(owner, 4)
    commitPages = [[commit(sha40(4), 'fix: d', sha40(21)), commit(sha40(21), 'chore: e', sha40(1)), commit(sha40(1), 'x', null)]]
    expect((await suggest(owner)).suggestion).toMatchObject({ version: 'v.0.1.3.0', commits: 2, counts: { feature: 0, fix: 1, other: 1 } })
    expect(commitCalls).toHaveLength(4)
  })

  it('base не найден — предложения нет, ручной ввод работает', async () => {
    const owner = await withCurrent()
    commitPages = [[commit(sha40(2), 'fix: a', sha40(30)), commit(sha40(30), 'chore: b', null)]]
    expect(await suggest(owner)).toMatchObject({ suggestion: null, suggestionError: expect.stringMatching(/не найден/) })
    expect((await put(owner, { version: 'v.0.1.2.4', ...(await seenBy(owner)) })).status).toBe(200)
  })

  it('GitHub 403 или 429 — предложения нет с причиной', async () => {
    const owner = await withCurrent()
    commitsStatus = 429
    expect(await suggest(owner)).toMatchObject({ suggestion: null, suggestionError: expect.stringMatching(/HTTP 429/) })
  })
})

describe('GET /api/public/release', () => {
  it('без сессии: {version: null}, затем только версия и время; кэш 60 с', async () => {
    const empty = await app.request('/api/public/release')
    expect(empty.status).toBe(200)
    expect(empty.headers.get('cache-control')).toBe('public, max-age=60')
    expect(await empty.json()).toEqual({ version: null })

    runs = [ghRun(1)]
    const owner = api(app, await login(app))
    expect((await put(owner, { version: 'v.0.1.0.0', note: 'секрет', expectedRev: 0, ...AUTO1 })).status).toBe(200)
    const res = await app.request('/api/public/release')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['setAt', 'version'])
    expect(body.version).toBe('v.0.1.0.0')
    expect(typeof body.setAt).toBe('number')
    for (const leak of [SHA1.slice(0, 7), 'owner@ops.test', 'секрет']) expect(text).not.toContain(leak)
    // Сессионный ответ — no-store, как остальное API.
    const session = await app.request('/api/release', { headers: { Cookie: await login(app) } })
    expect(session.headers.get('cache-control')).toBe('no-store')
  })
})
