/**
 * Один «тик» фоновой работы. Вызывается: локально — таймером процесса (server/local.ts);
 * на Vercel — /api/cron/tick (Vercel Cron, cron-job.org, GitHub Actions) и попутно из отчёта
 * агента. Периодичность задач держится отметками в БД, а не памятью процесса — serverless
 * не помнит прошлый вызов.
 */
import { and, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { activity, alerts, checkResults, checkRollups, containers, deliveries, metricSamples, reports } from '../db/schema'
import { expireStaleCommands } from '../containers/commands'
import { runDueChecks } from '../monitors/checks'
import { checkTlsCertificates } from '../monitors/tls'
import { syncGithubDeploysOnce } from '../deploys/sync-once'
import { pruneDeployProgress } from '../deploys/progress'
import { evaluateDeploySlow } from '../deploys/alerts'
import { evaluateAgentSilence } from '../agents/silence'
import { pruneVpn } from '../agents/vpn'
import { pruneAuthTables } from '../auth/session'
import { ensureBuiltinRules } from '../alerts/builtin'
import { pruneBusyEpisodes } from '../alerts/container-busy'
import { generateAndSend, redeliverReports, scheduledReportSince, sendDailyDigest } from '../reports/deliver'
import { getGeneralSettings, getReportSettings, readMarker, readReportPeriod, writeMarker, writeReportPeriod } from '../settings/store'
import { releaseLease, tryAcquireLease } from './lease'
import { notifyStableFlaps } from '../alerts/store'
import { httpRequest } from '../lib/http'
import { getEgressAllowlist } from '../settings/store'
import { pruneTelegramTables, sweepSsoSubscriptions, telegramTick } from '../telegram/bot'
import { sweepFiles, sweepTmp } from '../queue/files/sweep'

/**
 * «Пульс» наружу (healthchecks.io и т. п.): консоль сама не может сообщить о своей смерти или
 * о падении сервера, на котором живёт. Внешний сервис ждёт пинг раз в минуту и бьёт тревогу,
 * если пингов нет.
 */
async function pingHeartbeat(): Promise<void> {
  const { heartbeatUrl } = await getGeneralSettings()
  if (!heartbeatUrl) return
  const res = await httpRequest(heartbeatUrl, { timeoutMs: 10_000, allowPrivateHosts: await getEgressAllowlist(), maxBytes: 4096 })
  if (res.status >= 400) throw new Error(`heartbeat: HTTP ${res.status}`)
}

const DAY = 86_400_000
const TICK_LEASE_MS = 55_000

export interface TickSummary {
  ran: boolean
  checks: number
  tasks: Record<string, 'ok' | 'skipped' | string>
}

async function every(key: string, intervalMs: number, now: number, fn: () => Promise<unknown>): Promise<'ok' | 'skipped' | string> {
  if (now - (await readMarker(key)) < intervalMs) return 'skipped'
  await writeMarker(key, now)
  try {
    await fn()
    return 'ok'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[ops] task ${key} failed:`, message)
    return `error: ${message.slice(0, 200)}`
  }
}

export function reportPeriodKey(period: 'daily' | 'weekly', now: Date): string {
  const day = now.toISOString().slice(0, 10)
  if (period === 'daily') return `daily:${day}`
  // ISO-неделя: четверг этой недели определяет год и номер.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7)
  return `weekly:${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

async function maybeSendScheduledReport(now: Date): Promise<'ok' | 'skipped' | string> {
  const cfg = await getReportSettings()
  if (!cfg.enabled || now.getUTCHours() < cfg.hourUtc) return 'skipped'
  if (cfg.period === 'weekly' && now.getUTCDay() !== 1) return 'skipped'
  const key = reportPeriodKey(cfg.period, now)
  // Ключ периода — в своей записи: форма владельца сохраняет «reports» целиком и не должна его затирать.
  if (((await readReportPeriod()) || cfg.lastPeriodKey) === key) return 'skipped'
  // Отметка — после того, как отчёт сохранён: перезапуск посреди сборки не теряет период. Перезапуск между
  // записью отчёта и отметкой ловит таблица отчётов, и период не собирается дважды. Окно периода начинается
  // сегодня в 00:00 UTC: недельный отчёт собирается только по понедельникам. Недоставленный повторяет
  // redeliverReports.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (!(await scheduledReportSince(cfg.period, periodStart))) {
    const res = await generateAndSend(cfg.period, 'scheduler')
    await writeReportPeriod(key)
    return res.status === 'failed' ? `error: ${res.error}` : 'ok'
  }
  await writeReportPeriod(key)
  return 'skipped'
}

async function cleanup(): Promise<void> {
  const db = getDb()
  const g = await getGeneralSettings()
  const now = Date.now()
  await db.delete(checkResults).where(lt(checkResults.createdAt, new Date(now - g.checkRetentionDays * DAY)))
  await db.delete(checkRollups).where(lt(checkRollups.bucketStart, now - g.rollupRetentionDays * DAY))
  // Счётчик перезапусков пишется только при изменении, и его последний замер — база окна правила «перезапуск по
  // кругу». Удали его срок хранения — первый всплеск после месяца тишины недосчитался бы на перезапуск и не дотянул
  // до порога. Последний замер счётчика каждого существующего контейнера остаётся, сколько бы ему ни было.
  await db.delete(metricSamples).where(
    and(
      lt(metricSamples.createdAt, new Date(now - g.metricRetentionDays * DAY)),
      sql`${metricSamples.id} not in (select max(s.id) from ${metricSamples} s join ${containers} c on c.agent_id = s.agent_id and s.metric = 'restarts:' || c.name group by s.agent_id, s.metric)`,
    ),
  )
  // Доставки горящего алерта не удаляем: по ним находится карточка Telegram (ответы в ветку,
  // переписывание итога). Срок хранения можно опустить до 7 дней, а алерт горит дольше.
  await db
    .delete(deliveries)
    .where(
      and(
        lt(deliveries.createdAt, new Date(now - g.deliveryRetentionDays * DAY)),
        sql`not exists (select 1 from ${alerts} where ${alerts.id} = ${deliveries.alertId} and ${alerts.status} = 'firing')`,
      ),
    )
  await db.delete(activity).where(lt(activity.createdAt, new Date(now - g.activityRetentionDays * DAY)))
  // Отчёты по умолчанию собираются каждый день — история полгода, дальше не нужна ни совету, ни людям.
  await db.delete(reports).where(lt(reports.createdAt, new Date(now - 180 * DAY)))
  await pruneVpn(now)
  await pruneDeployProgress(now)
  await pruneBusyEpisodes(now)
  await pruneAuthTables()
  await pruneTelegramTables()
}

/**
 * `light` — попутный тик из отчёта агента (serverless): только проверки доступности, «агент молчит»
 * и срок жизни команд. Остальное (GitHub, TLS, ретенция, дайджест, отчёт) — в полном тике от cron:
 * отчёт агента не должен ждать медленных внешних API и упираться в таймаут функции.
 */
export async function runTick(opts: { light?: boolean } = {}): Promise<TickSummary> {
  if (!(await tryAcquireLease('tick', TICK_LEASE_MS))) return { ran: false, checks: 0, tasks: {} }
  const now = Date.now()
  const tasks: TickSummary['tasks'] = {}
  let checks = 0
  try {
    await ensureBuiltinRules()
    try {
      checks = await runDueChecks(now)
      tasks.checks = 'ok'
    } catch (err) {
      tasks.checks = `error: ${err instanceof Error ? err.message : String(err)}`
    }
    tasks.agents = await evaluateAgentSilence().then(
      () => 'ok',
      (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
    )
    tasks.deploySlow = await evaluateDeploySlow(now).then(
      () => 'ok',
      (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
    )
    await expireStaleCommands(undefined, now)
    tasks.flaps = await notifyStableFlaps().then(
      () => 'ok',
      (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
    )
    tasks.heartbeat = await every('heartbeat', 55_000, now, pingHeartbeat)
    if (!opts.light) {
      tasks.github = await every('github', 120_000, now, syncGithubDeploysOnce)
      tasks.tls = await every('tls', 6 * 3_600_000, now, checkTlsCertificates)
      tasks.cleanup = await every('cleanup', DAY, now, cleanup)
      tasks.oqFiles = await every('oq-files', DAY, now, () => sweepFiles(now))
      tasks.oqFilesTmp = await every('oq-files-tmp', 3_600_000, now, () => sweepTmp(now))
      tasks.telegram = await every('telegram', 5 * 60_000, now, telegramTick)
      tasks.telegramSso = await every('telegram-sso', 15 * 60_000, now, sweepSsoSubscriptions)
      const hourOk = new Date(now).getUTCHours() >= (await getReportSettings()).hourUtc
      tasks.digest = hourOk ? await every('digest', DAY - 30 * 60_000, now, sendDailyDigest) : 'skipped'
      tasks.report = await maybeSendScheduledReport(new Date(now)).catch(
        (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
      )
      tasks.redeliver = await every('report-redeliver', 5 * 60_000, now, () => redeliverReports(now))
    }
    await writeMarker('tick', now)
  } finally {
    await releaseLease('tick')
  }
  return { ran: true, checks, tasks }
}
