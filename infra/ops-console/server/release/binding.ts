/**
 * К какому SHA привязать новую версию продукта. Берётся последний успешный не ручной деплой. Если новее него есть
 * запуск, который мог поменять прод (ручной — откат или перевыкладка, упавший после выката, идущий), SHA вставляет
 * владелец: `head_sha` ручного запуска — вершина ветки, а не выкаченный коммит (server/deploys/github.ts).
 */
import { desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { deploys } from '../db/schema'
import { MANUAL_RUN_TITLE, NOT_STARTED } from '../deploys/github'
import { getGithubSettings } from '../settings/store'
import type { BindingReason, BindingRun, ReleaseBinding } from '../../shared/release'

export type DeployRow = typeof deploys.$inferSelect

/** Строк хватает с запасом: опрос GitHub приносит 15 последних запусков за раз. */
const ROWS = 50
const FAILED = new Set(['failure', 'timed_out', 'cancelled'])
const IGNORED = new Set([NOT_STARTED, 'skipped'])

const runKeyNum = (r: DeployRow) => {
  const n = Number(r.runKey)
  return Number.isFinite(n) ? n : -1
}

const isGood = (r: DeployRow) => r.status === 'completed' && r.conclusion === 'success' && r.title !== MANUAL_RUN_TITLE

/** Чем запуск новее последнего успешного мог задеть прод; null — не мог (не стартовал, пропущен, нейтрален). */
function prodReason(r: DeployRow): Exclude<BindingReason, 'no_deploy'> | null {
  if (r.conclusion && IGNORED.has(r.conclusion)) return null
  if (r.title === MANUAL_RUN_TITLE) return 'manual_run'
  if (r.status !== 'completed') return 'in_progress'
  if (r.conclusion && FAILED.has(r.conclusion)) return 'failed_run'
  return null
}

const toRun = (r: DeployRow): BindingRun => ({
  runKey: r.runKey,
  url: r.url,
  title: r.title,
  status: r.status,
  conclusion: r.conclusion,
  at: (r.finishedAt ?? r.startedAt ?? r.createdAt).getTime(),
})

/** Чистая логика привязки: строки в любом порядке, новизна — по номеру запуска GitHub. */
export function computeBinding(rows: readonly DeployRow[]): ReleaseBinding {
  const sorted = [...rows].sort((a, b) => runKeyNum(b) - runKeyNum(a))
  const goodAt = sorted.findIndex(isGood)
  const good = goodAt === -1 ? null : (sorted[goodAt] ?? null)
  const newer = goodAt === -1 ? sorted : sorted.slice(0, goodAt)
  for (const r of newer) {
    const reason = prodReason(r)
    if (reason) return { mode: 'confirm', reason, sha: good?.headSha ?? null, run: toRun(r) }
  }
  if (!good) return { mode: 'confirm', reason: 'no_deploy', sha: null, run: null }
  return { mode: 'auto', sha: good.headSha, run: toRun(good) }
}

/** Последние запуски настроенного workflow (опрос пишет только ветку main). */
export async function loadDeployRows(): Promise<DeployRow[]> {
  const gh = await getGithubSettings()
  return getDb().query.deploys.findMany({
    where: eq(deploys.workflow, gh.workflow),
    orderBy: desc(sql`cast(${deploys.runKey} as integer)`),
    limit: ROWS,
  })
}

/** Время старта самого раннего деплоя этого коммита: от него — окно `since` для списка коммитов. */
export async function deployStartedAt(sha: string): Promise<number | null> {
  const prefix = sha.slice(0, 12)
  if (!/^[0-9a-f]{7,12}$/.test(prefix)) return null
  const row = await getDb().query.deploys.findFirst({
    where: sql`${deploys.headSha} like ${`${prefix}%`}`,
    orderBy: deploys.startedAt,
  })
  return row ? (row.startedAt ?? row.createdAt).getTime() : null
}
