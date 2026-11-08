/**
 * Версия продукта (APP-558): чтение — любой сессии, запись — владельцу. Подвалы продукта читают публичный
 * `/api/public/release` (только версия и время): единственный источник версии — эта панель.
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireRole } from '../auth/middleware'
import { apiError, type AppEnv } from '../http-types'
import { parseBody } from '../lib/validate'
import { logActivity } from '../activity'
import { readSetting } from '../settings/store'
import { deploySyncSchema, syncGithubDeploys } from '../deploys/github'
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
  type ReleaseResponse,
  type ReleaseSuggestion,
} from '../../shared/release'

/** Чтение синхронизирует деплои, только если прошлый опрос старше минуты (отметка общая для всех сессий). */
const SYNC_FRESH_MS = 60_000

const putSchema = z.object({
  version: z.string().trim().regex(RELEASE_VERSION_RE, 'версия в формате v.A.B.C.D, сегменты 0–9999 без ведущих нулей'),
  note: z.string().trim().max(RELEASE_NOTE_MAX).default(''),
  expectedRev: z.number().int().min(0),
  /** SHA привязки, который видел владелец (`binding.sha`, пусто — его не было). */
  expectedSha: z.string().max(40),
  /** Вставленный SHA — только когда привязка требует подтверждения. */
  sha: z.string().trim().toLowerCase().regex(RELEASE_SHA_RE, 'SHA — 7–40 шестнадцатеричных знаков').optional(),
  confirmLower: z.boolean().default(false),
})
type PutBody = z.infer<typeof putSchema>

/** Опрос GitHub; его сбой не блокирует ни чтение, ни запись — возвращается текстом. */
async function syncNow(): Promise<string | null> {
  try {
    const r = await syncGithubDeploys()
    return r === 'not_configured' ? 'GitHub не настроен: Настройки → Интеграции' : null
  } catch (err) {
    return `GitHub: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
  }
}

async function syncIfStale(): Promise<string | null> {
  const last = await readSetting('deploy_sync', deploySyncSchema)
  if (Date.now() - last.at > SYNC_FRESH_MS) return syncNow()
  return last.ok ? null : last.error || null
}

type SuggestionPart = { suggestion: ReleaseSuggestion | null; suggestionError: string | null }

async function suggestionFor(state: ReleaseState, binding: ReleaseBinding): Promise<SuggestionPart> {
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

/** Какой SHA привязать: привязка пересчитана после опроса GitHub; разошлась с тем, что видел владелец, — 409. */
function boundSha(binding: ReleaseBinding, body: PutBody): string {
  if ((binding.sha ?? '') !== body.expectedSha) throw apiError(409, 'Новый деплой — проверьте ещё раз')
  if (binding.mode === 'auto') {
    if (body.sha) throw apiError(409, 'Деплои изменились: SHA теперь берётся сам — проверьте ещё раз')
    return binding.sha
  }
  if (!body.sha) throw apiError(409, 'Последний запуск не подтверждён — проверьте ещё раз и вставьте SHA выкаченного коммита')
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
    const syncError = await syncIfStale()
    const [snap, rows] = await Promise.all([readRelease(), loadDeployRows()])
    const binding = computeBinding(rows)
    const owner = c.get('user').role === 'owner'
    const part: SuggestionPart = owner ? await suggestionFor(snap.state, binding) : { suggestion: null, suggestionError: null }
    const body: ReleaseResponse = { rev: snap.state.rev, current: snap.state.current, history: snap.state.history, binding, ...part, syncError }
    return c.json(body)
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
