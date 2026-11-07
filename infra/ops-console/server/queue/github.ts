/**
 * Мёрж и деплой из очереди владельца (веб /queue и Telegram-бот очереди). Гарантии:
 *  - вливается только то, что одобрил «Контроль»: полный SHA головы (`sha`) и база PR (`base`) в пункте мёржа.
 *    Вердикта нет — кнопка неактивна, сервер отказывает; голова или база PR сменились после вердикта — отказ до
 *    нового вердикта (одна и та же голова в PR на склейку и в PR на main — разные вливания);
 *  - вливается ровно тот head SHA, который показали владельцу (GitHub сам откажет, если ветку допушили);
 *  - [skip ci] — из пункта (deploy: 'skip', команда или subject с [skip ci]); иначе мёрж в main запускает деплой прода;
 *  - способ (merge|squash) и заголовок коммита — из пункта (mergeMethod, subject) или его команды (--squash, --subject);
 *  - PR другого репозитория (поле repo или -R в команде) — честный отказ 409 до запроса к GitHub (Q-29);
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
export function setGithubTransportForTests(t: Transport | null): void {
  transport = t ?? realTransport
}

const MERGE_GAP_MS = 30_000
let lastMergeAt = 0

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
}

const FULL_SHA = /^[0-9a-f]{40}$/
export const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/
const SUBJECT = /^[^\r\n]{1,300}$/

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Флаги `gh pr merge …` по словам shell, а не по сырому тексту: `--subject "fix -s flag"` — заголовок, а не squash.
 * Только сама команда мёржа: `curl -s` или `git log -t` после && способ не меняют.
 */
function mergeFlags(cmd: string): { pr: number | null; repo: string | null; squash: boolean; subject: string | null } {
  const segment = cmd.match(/gh pr merge(?:[^\n;&|"']|"[^"]*"|'[^']*')*/)?.[0] ?? ''
  const words = (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
  const out = { pr: Number(words[3]) || null, repo: null as string | null, squash: false, subject: null as string | null }
  for (let i = 3; i < words.length; i++) {
    const word = words[i] ?? ''
    const eq = word.startsWith('--') ? word.indexOf('=') : -1
    const [flag, inline] = eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : [word, null]
    const value = () => inline ?? words[++i] ?? null
    if (flag === '-R' || flag === '--repo') out.repo = value()
    else if (flag === '--subject' || flag === '-t') out.subject = value()
    else if (flag === '--body' || flag === '-b' || flag === '--body-file' || flag === '-F' || flag === '--match-head-commit' || flag === '--author-email' || flag === '-A') value()
    else if (flag === '--squash' || flag === '-s') out.squash = true
  }
  return out
}

/** Номер PR и последствия мёржа — из полей пункта или (для пунктов из артефакта) из его команды и меток. */
export function mergePlan(item: Record<string, unknown>): MergePlan {
  const cmd = typeof item.cmd === 'string' ? item.cmd : ''
  const flags = mergeFlags(cmd)
  const pr = typeof item.pr === 'number' ? item.pr : flags.pr
  const approvedSha = typeof item.sha === 'string' && FULL_SHA.test(item.sha) ? item.sha : null
  const approvedBase = typeof item.base === 'string' && BRANCH_NAME.test(item.base) ? item.base : null
  // Не проверяем формат здесь: кривое имя не совпадёт с репозиторием консоли, и mergeInfo откажет (fail-closed).
  const repo = str(item.repo) ?? str(flags.repo)
  const method = item.mergeMethod === 'squash' || (item.mergeMethod === undefined && flags.squash) ? 'squash' : 'merge'
  const subjectRaw = str(item.subject) ?? flags.subject
  const subject = subjectRaw && SUBJECT.test(subjectRaw.trim()) ? subjectRaw.trim() : null
  const skipCi = item.deploy === 'skip' || /\[skip ci\]/i.test(cmd) || /\[skip ci\]/i.test(subject ?? '')
  // Мёрж в main с кодом деплоит прод — поэтому деплой ожидается, если пункт не говорит обратное:
  // [skip ci], deploy: 'none' (только docs/md — paths-ignore) или метка «без деплоя».
  const chips = Array.isArray(item.chips) ? (item.chips as unknown[][]) : []
  const saysNoDeploy = chips.some((c) => Array.isArray(c) && typeof c[0] === 'string' && /без деплоя/i.test(c[0]))
  const deploys = item.deploy ? item.deploy === 'deploy' : !skipCi && !saysNoDeploy
  return { pr, skipCi, deploys, approvedSha, approvedBase, repo, method, subject }
}

/** Тело PUT /pulls/N/merge: способ из пункта, заголовок — свой или GitHub по способу, с [skip ci] если нужно. */
export function mergeRequestBody(
  info: Pick<MergeInfo, 'pr' | 'title' | 'headRef' | 'skipCi' | 'method' | 'subject' | 'repo'>,
  sha: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { sha, merge_method: info.method }
  let title = info.subject
  if (!title && info.skipCi) {
    title = info.method === 'squash' ? `${info.title} (#${info.pr})` : `Merge pull request #${info.pr} from ${info.repo.split('/')[0]}/${info.headRef}`
  }
  if (title && info.skipCi && !/\[skip ci\]/i.test(title)) title = `${title} [skip ci]`
  if (title) body.commit_title = title
  return body
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

async function deployRunning(repo: string, workflow: string, token: string): Promise<boolean> {
  const res = await call('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=5`, token)
  if (res.status !== 200) return false
  return runsSchema.parse(JSON.parse(res.text)).workflow_runs.some((r) => r.status !== 'completed')
}

export interface MergeInfo extends Omit<MergePlan, 'repo'> {
  itemId: string
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
export async function mergeInfo(itemId: string): Promise<MergeInfo> {
  const item = await getDoc('items', itemId, '*')
  if (!item || item.data.kind !== 'merge') throw apiError(404, 'Нет такого пункта мёржа')
  // Репозиторий и токен мёржа — пока только HR (настройки консоли): пункт другого продукта влил бы PR не в тот
  // репозиторий. Мёрж по продукту — после точки невозврата PNR-1 (план, фаза 7), отдельным «да».
  if (item.product !== DEFAULT_PRODUCT) throw apiError(409, `Мёрж из очереди для продукта «${item.product}» ещё не подключён`)
  const plan = mergePlan(item.data)
  if (!plan.pr) throw apiError(422, 'В пункте нет номера PR (поле pr или команда gh pr merge N)')
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

export async function mergeItem(actor: Actor, itemId: string, sha: string): Promise<{ sha: string; message: string }> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Вливает только владелец')
  if (!/^[0-9a-f]{40}$/.test(sha)) throw apiError(422, 'Нужен полный SHA, показанный на экране подтверждения')
  if (Date.now() - lastMergeAt < MERGE_GAP_MS) throw apiError(429, 'Мёржи не чаще раза в 30 секунд — подождите')
  const info = await mergeInfo(itemId)
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
  lastMergeAt = Date.now()
  const body = mergeRequestBody(info, sha)
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
