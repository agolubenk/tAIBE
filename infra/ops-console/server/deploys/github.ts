/** Деплои из GitHub Actions (workflow из настроек, по умолчанию deploy-contabo.yml). */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { deploys } from '../db/schema'
import { decryptSecret } from '../lib/crypto'
import { httpRequest } from '../lib/http'
import { getGithubSettings, writeSetting } from '../settings/store'
import { getRulesByKind, observe, type Fact } from '../alerts/store'
import { logActivity } from '../activity'
import { humanDuration } from '../lib/time'
import { deployFailedFingerprint, deployObject } from './alerts'

const runSchema = z.object({
  id: z.number(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  head_sha: z.string().default(''),
  head_branch: z.string().nullable().optional(),
  event: z.string().default(''),
  display_title: z.string().default(''),
  head_commit: z.object({ message: z.string().default('') }).nullable().optional(),
  html_url: z.string().default(''),
  run_started_at: z.string().nullable().optional(),
  updated_at: z.string(),
  actor: z.object({ login: z.string() }).nullable().optional(),
})

/**
 * Прод деплоится только из этой ветки (раннер на VPS исполняет deploy-contabo.yml лишь из main).
 * Запуск с другой ветки — проверка или отказ раннера, а не выкладка: в таблицу деплоев он
 * попадает, но не открывает и не закрывает алерт и не пишется в ленту.
 */
const PROD_BRANCH = 'main'

/**
 * Что выкатывал запуск. У ручного (Run workflow, в т.ч. откат с полем ref) head_sha/head_commit —
 * вершина ветки, а не выкаченный коммит, а display_title — имя workflow: честно пишем «ручной
 * запуск», коммит — в логе запуска.
 */
const manual = (run: z.infer<typeof runSchema>) => run.event === 'workflow_dispatch'
/** Заголовок ручного запуска в таблице deploys: по нему колонка «Связь» не связывает такой деплой по коммиту. */
export const MANUAL_RUN_TITLE = 'ручной запуск'
/** Заголовок коммита в таблице deploys обрезан до этой длины: колонка «Связь» сравнивает с ним subject пункта мёржа. */
export const DEPLOY_TITLE_MAX = 250
const commitTitle = (run: z.infer<typeof runSchema>) =>
  (manual(run) ? MANUAL_RUN_TITLE : run.head_commit?.message.split('\n')[0] || run.display_title).slice(0, DEPLOY_TITLE_MAX)
const commitLine = (run: z.infer<typeof runSchema>) =>
  manual(run) ? 'ручной запуск (Run workflow) — коммит в логе запуска' : `${run.head_sha.slice(0, 7)} «${commitTitle(run)}»`
const runsSchema = z.object({ workflow_runs: z.array(runSchema).default([]) })
const stepSchema = z.object({ name: z.string().default(''), conclusion: z.string().nullable().optional() })
const jobsSchema = z.object({
  jobs: z.array(z.object({ name: z.string().default(''), steps: z.array(stepSchema).default([]) })).default([]),
})

/** Свой статус консоли: GitHub пометил запуск failure, но ни одна задача не стартовала. */
export const NOT_STARTED = 'not_started'
/** Завершения старше этого — история: без алерта и записи в ленту. */
const FRESH_MS = 60 * 60_000
/** Шаг, который выкатывает релиз на сервер («Деплой на VPS», «Deploy»). */
const DEPLOY_STEP = /деплой|deploy/i

/** Что известно о падении запуска по его шагам. */
interface RunFailure {
  /** Ни одна задача не стартовала (лимит или оплата Actions) — не падение кода. */
  notStarted: boolean
  /** Первый упавший шаг, как его покажем людям. */
  failedStep: string | null
  /** Упал сам шаг деплоя: часть сервисов могла уже обновиться. */
  failedIsDeploy: boolean
  /** Шаг деплоя прошёл, а упало что-то после него: новая версия уже на проде. */
  deployedStep: string | null
}

const UNKNOWN_FAILURE: RunFailure = { notStarted: false, failedStep: null, failedIsDeploy: false, deployedStep: null }

async function inspectFailure(repo: string, runId: number, auth: Record<string, string>): Promise<RunFailure> {
  try {
    const res = await httpRequest(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`, {
      headers: { ...auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
    })
    if (!res.ok) return UNKNOWN_FAILURE
    const { jobs } = jobsSchema.parse(JSON.parse(res.text))
    if (jobs.length > 0 && jobs.every((j) => j.steps.length === 0)) return { ...UNKNOWN_FAILURE, notStarted: true }
    for (const job of jobs) {
      const at = job.steps.findIndex((st) => st.conclusion === 'failure')
      const failed = job.steps[at]
      if (!failed) continue
      const deployed = job.steps.slice(0, at).find((st) => st.conclusion === 'success' && DEPLOY_STEP.test(st.name))
      const name = failed.name || 'без имени'
      return {
        notStarted: false,
        failedStep: jobs.length > 1 && job.name ? `${job.name} → ${name}` : name,
        failedIsDeploy: DEPLOY_STEP.test(failed.name),
        deployedStep: deployed ? deployed.name : null,
      }
    }
    return UNKNOWN_FAILURE
  } catch {
    return UNKNOWN_FAILURE
  }
}

/** Что делать — по тому, на каком шаге упало: на проде старая версия, новая или наполовину. */
function deployHint(f: RunFailure): string {
  const rerun = 'после исправления — новый push или Run workflow.'
  if (f.notStarted) {
    return 'Задача даже не стартовала: у GitHub Actions закончился лимит расходов или не прошла оплата (Settings → Billing & plans). Прод остался на предыдущей версии.'
  }
  if (f.deployedStep) {
    return `Новая версия уже выкачена (шаг «${f.deployedStep}» прошёл), не прошла проверка после него${f.failedStep ? ` — «${f.failedStep}»` : ''}. Откройте сайт и лог шага: если всё работает, это сбой проверки, а не релиза; алерт закроется со следующим успешным деплоем.`
  }
  if (f.failedStep && f.failedIsDeploy) {
    return `Упал сам шаг деплоя «${f.failedStep}»: часть сервисов могла уже обновиться. Проверьте сайт и лог шага; ${rerun}`
  }
  if (f.failedStep) return `Упал шаг «${f.failedStep}» — до выката дело не дошло, прод на предыдущей версии; ${rerun}`
  return `Прод остался на предыдущей версии. Откройте запуск в GitHub и найдите упавший шаг; ${rerun}`
}

export const deploySyncSchema = z.object({
  at: z.number().default(0),
  ok: z.boolean().default(false),
  error: z.string().default(''),
})
export type DeploySync = z.infer<typeof deploySyncSchema>

/** Опрос с отметкой результата — карточка «Интеграции» на странице деплоев показывает, жив ли источник. */
export async function syncGithubDeploys(): Promise<'not_configured' | 'ok'> {
  try {
    const r = await pollGithubDeploys()
    await writeSetting('deploy_sync', { at: Date.now(), ok: r === 'ok', error: r === 'ok' ? '' : 'не настроено' } satisfies DeploySync)
    return r
  } catch (err) {
    await writeSetting('deploy_sync', { at: Date.now(), ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) } satisfies DeploySync)
    throw err
  }
}

export async function pollGithubDeploys(): Promise<'not_configured' | 'ok'> {
  const gh = await getGithubSettings()
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh.repo) || !/^[\w.-]+$/.test(gh.workflow)) return 'not_configured'
  // Без токена — анонимный запрос: для публичного репозитория хватает (60 запросов/час, опрос раз в 2 мин).
  const auth: Record<string, string> = gh.tokenEnc ? { Authorization: `Bearer ${decryptSecret(gh.tokenEnc)}` } : {}
  const res = await httpRequest(`https://api.github.com/repos/${gh.repo}/actions/workflows/${gh.workflow}/runs?branch=${PROD_BRANCH}&per_page=15`, {
    headers: { ...auth, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
  })
  if (res.status === 404 && !gh.tokenEnc) {
    throw new Error('GitHub: репозиторий приватный или workflow не найден — задайте токен (Настройки → Интеграции)')
  }
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`)
  const { workflow_runs: runs } = runsSchema.parse(JSON.parse(res.text))
  const db = getDb()
  const rules = await getRulesByKind('deploy_failed')
  // От старых к новым: последнее завершение определяет, горит ли «деплой упал».
  for (const run of [...runs].reverse()) {
    const runKey = String(run.id)
    const prev = await db.query.deploys.findFirst({ where: eq(deploys.runKey, runKey) })
    const justCompleted = run.status === 'completed' && prev?.status !== 'completed'
    const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out'
    // Шаги свежеупавшего запуска: какой упал и успел ли выкат. Задача, которую GitHub даже не
    // запустил (лимит/оплата Actions, нет раннера), — не падение кода.
    const failure = justCompleted && failed ? await inspectFailure(gh.repo, run.id, auth) : UNKNOWN_FAILURE
    const conclusion = failure.notStarted ? NOT_STARTED : run.conclusion
    const row = {
      runKey,
      workflow: gh.workflow,
      status: run.status ?? 'unknown',
      conclusion: prev?.conclusion === NOT_STARTED ? NOT_STARTED : conclusion,
      headSha: run.head_sha.slice(0, 12),
      title: commitTitle(run),
      actor: run.actor?.login ?? '',
      url: run.html_url,
      startedAt: run.run_started_at ? new Date(run.run_started_at) : null,
      finishedAt: run.status === 'completed' ? new Date(run.updated_at) : null,
    }
    if (prev) await db.update(deploys).set(row).where(eq(deploys.runKey, runKey))
    else await db.insert(deploys).values({ ...row, createdAt: new Date() })
    if (!justCompleted) continue
    // История (первое подключение GitHub, долгий простой консоли) — только в таблицу деплоев:
    // алерт и запись в ленту о падении недельной давности никому не нужны.
    if (Date.now() - new Date(run.updated_at).getTime() > FRESH_MS) continue
    if (run.head_branch && run.head_branch !== PROD_BRANCH) continue
    const notStarted = conclusion === NOT_STARTED
    const checkFailed = failed && Boolean(failure.deployedStep)
    await logActivity(
      'deploy',
      `${notStarted ? '🔴 Деплой не запустился' : checkFailed ? '🟠 Выкачен, но не прошла проверка' : failed ? '🔴 Деплой упал' : run.conclusion === 'success' ? '🟢 Деплой успешен' : `Деплой: ${run.conclusion}`} — ${row.title}`,
      row.actor || 'github',
      '/deploys',
    )
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') continue
    const took = row.startedAt && row.finishedAt ? humanDuration(row.finishedAt.getTime() - row.startedAt.getTime()) : null
    for (const rule of rules) {
      await observe({
        rule,
        fingerprint: deployFailedFingerprint(rule.id, gh.workflow),
        breached: failed,
        title: notStarted ? 'Деплой не запустился' : checkFailed ? 'Проверка после деплоя не прошла' : rule.name,
        object: deployObject(gh.workflow),
        value: notStarted
          ? 'GitHub не запустил задачу'
          : failure.failedStep
            ? `упал шаг «${failure.failedStep}» — ${row.title}`
            : `${run.conclusion ?? 'ошибка'} — ${row.title}`,
        facts: [
          ['Коммит', commitLine(run)],
          ['Автор', row.actor || '—'],
          ...(failure.failedStep ? ([['Упавший шаг', failure.failedStep]] as Fact[]) : []),
          ...(checkFailed ? ([['Прод', 'новая версия выкачена']] as Fact[]) : []),
          ...(took !== null && !notStarted ? ([['Длительность', took]] as Fact[]) : []),
        ],
        hint: deployHint(failure),
        links: run.html_url ? [['Запуск в GitHub', run.html_url]] : [],
        route: '/deploys',
        recovery: `следующий деплой успешен: ${commitLine(run)}`,
      })
    }
  }
  return 'ok'
}
