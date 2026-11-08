/**
 * Версия продукта (APP-558): чтение — любой сессии, предложение и запись — владельцу. Подвалы продукта читают
 * публичный `/api/public/release` (только версия и время): единственный источник версии — эта панель.
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireRole } from '../auth/middleware'
import { apiError, roleAtLeast, type AppEnv, type Role } from '../http-types'
import { parseBody } from '../lib/validate'
import { logActivity } from '../activity'
import { readSetting } from '../settings/store'
import { deploySyncSchema } from '../deploys/github'
import { syncGithubDeploysOnce } from '../deploys/sync-once'
import { computeBinding, deployStartedAt, loadDeployRows } from '../release/binding'
import { nextReleaseState, readRelease, writeRelease, type ReleaseState } from '../release/store'
import { suggestRelease } from '../release/suggest'
import {
  compareReleaseVersions,
  parseReleaseVersion,
  RELEASE_NOTE_MAX,
  RELEASE_SHA_RE,
  RELEASE_VERSION_RE,
  type PublicRelease,
  type ReleaseBinding,
  type ReleaseNav,
  type ReleaseResponse,
  type ReleaseSuggestionResponse,
} from '../../shared/release'

/** Тик опрашивает GitHub раз в 2 минуты: чтение добирает опрос, только если прошлый старше 150 с. */
const SYNC_FRESH_MS = 150_000

const putSchema = z.object({
  version: z.string().trim().regex(RELEASE_VERSION_RE, 'версия в формате v.A.B.C.D, сегменты 0–9999 без ведущих нулей'),
  note: z.string().trim().max(RELEASE_NOTE_MAX).default(''),
  expectedRev: z.number().int().min(0),
  /** Привязка, которую видел владелец: режим, запуск (`binding.run?.runKey`, пусто — нет) и SHA (пусто — нет). */
  expectedMode: z.enum(['auto', 'confirm']),
  expectedRunKey: z.string().max(40),
  expectedSha: z.string().max(40),
  /** Вставленный SHA — только когда привязка требует подтверждения. */
  sha: z.string().trim().toLowerCase().regex(RELEASE_SHA_RE, 'SHA — 7–40 шестнадцатеричных знаков').optional(),
  confirmLower: z.boolean().default(false),
})
type PutBody = z.infer<typeof putSchema>

/** Опрос GitHub (один на все запросы и тик); его сбой не блокирует ни чтение, ни запись — возвращается текстом. */
async function syncNow(): Promise<string | null> {
  try {
    const r = await syncGithubDeploysOnce()
    return r === 'not_configured' ? 'GitHub не настроен: Настройки → Интеграции' : null
  } catch (err) {
    return `GitHub: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
  }
}

/** Опрашивает только оператор и выше: наблюдатель видит деплои, которые принёс тик. */
async function syncIfStale(role: Role): Promise<string | null> {
  const last = await readSetting('deploy_sync', deploySyncSchema)
  if (roleAtLeast(role, 'operator') && Date.now() - last.at > SYNC_FRESH_MS) return syncNow()
  return last.ok ? null : last.error || null
}

async function suggestionFor(state: ReleaseState, binding: ReleaseBinding): Promise<ReleaseSuggestionResponse> {
  const cur = state.current
  if (!cur) return { suggestion: null, suggestionError: 'Первую версию задают вручную' }
  if (binding.mode !== 'auto') {
    return { suggestion: null, suggestionError: 'Последний запуск не подтверждён — предложения нет, версию введите вручную' }
  }
  try {
    const baseAt = (await deployStartedAt(cur.sha)) ?? cur.setAt
    const r = await suggestRelease({ currentVersion: cur.version, base: cur.sha, head: binding.sha, baseAt })
    return r.ok ? { suggestion: r.suggestion, suggestionError: null } : { suggestion: null, suggestionError: r.error }
  } catch (err) {
    console.warn('[ops] release suggestion failed:', err instanceof Error ? err.message : err)
    return { suggestion: null, suggestionError: 'Предложение не посчитано — введите версию вручную' }
  }
}

/**
 * Какой SHA привязать: привязка пересчитана после опроса GitHub. Режим, запуск или SHA разошлись с тем, что видел
 * владелец (новый деплой, ещё один ручной запуск), — 409.
 */
function boundSha(binding: ReleaseBinding, body: PutBody): string {
  const seen = binding.mode === body.expectedMode && (binding.run?.runKey ?? '') === body.expectedRunKey && (binding.sha ?? '') === body.expectedSha
  if (!seen) throw apiError(409, 'Новый деплой — проверьте ещё раз')
  if (binding.mode === 'auto') {
    if (body.sha) throw apiError(400, 'SHA вставляют, только когда привязка требует подтверждения')
    return binding.sha
  }
  if (!body.sha) throw apiError(400, 'Последний запуск не подтверждён — вставьте SHA выкаченного коммита')
  return body.sha
}

/** Та же или более низкая версия — только с явным подтверждением. */
function assertRaises(state: ReleaseState, body: PutBody): void {
  const next = parseReleaseVersion(body.version)
  const cur = state.current ? parseReleaseVersion(state.current.version) : null
  if (!next) throw apiError(400, 'version: формат v.A.B.C.D')
  if (cur && !body.confirmLower && compareReleaseVersions(next, cur) <= 0) {
    throw apiError(400, `Версия не выше текущей ${state.current?.version ?? ''} — подтвердите понижение`)
  }
}

export const releaseRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    if (c.req.query('view') === 'nav') {
      const cur = (await readRelease()).state.current
      const nav: ReleaseNav = cur ? { version: cur.version, sha: cur.sha } : { version: null, sha: null }
      return c.json(nav)
    }
    const syncError = await syncIfStale(c.get('user').role)
    const [snap, rows] = await Promise.all([readRelease(), loadDeployRows()])
    const { rev, current, history } = snap.state
    const body: ReleaseResponse = { rev, current, history, binding: computeBinding(rows), syncError }
    return c.json(body)
  })
  /** Без опроса GitHub: деплои уже принесло основное чтение панели. */
  .get('/suggestion', requireRole('owner'), async (c) => {
    const [snap, rows] = await Promise.all([readRelease(), loadDeployRows()])
    return c.json(await suggestionFor(snap.state, computeBinding(rows)))
  })
  .put('/', requireRole('owner'), async (c) => {
    const body = await parseBody(c, putSchema)
    const snap = await readRelease()
    if (snap.state.rev !== body.expectedRev) throw apiError(409, 'Версию уже изменили — обновите страницу')
    assertRaises(snap.state, body)
    const syncError = await syncNow()
    const sha = boundSha(computeBinding(await loadDeployRows()), body)
    const email = c.get('user').email
    const entry = { version: body.version, sha, setAt: Date.now(), setBy: email, note: body.note }
    const next = nextReleaseState(snap.state, entry)
    if (!(await writeRelease(snap, next))) throw apiError(409, 'Версию изменили параллельно — обновите страницу')
    const was = snap.state.current ? ` (было ${snap.state.current.version})` : ''
    await logActivity('config', `Версия продукта ${body.version} → ${sha.slice(0, 7)}${was}${body.note ? `: ${body.note}` : ''}`, email, '/deploys')
    return c.json({ rev: next.rev, current: entry, syncError })
  })

/** GET /api/public/release: версия и время установки, кэш 60 с (edge nginx). Сбой БД — 503, nginx отдаст прежний ответ. */
export async function publicRelease(c: Context<AppEnv>) {
  let body: PublicRelease
  try {
    const { state } = await readRelease()
    body = state.current ? { version: state.current.version, setAt: state.current.setAt } : { version: null }
  } catch {
    throw apiError(503, 'Версия временно недоступна')
  }
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(body)
}
