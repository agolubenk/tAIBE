/**
 * Сборка отчёта `hrh.ops.report/v1` за период — только агрегаты и факты, без PII.
 * Рекомендации — правила по фактам, не генерация: совет получает данные, выводы делает сам.
 */
import { and, avg, count, desc, eq, gte, isNull, lt, lte, max, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, checkRollups, commands, containers, deploys, incidents, metricSamples, monitors, reports, tlsChecks } from '../db/schema'
import { getEnv } from '../env'
import { getGeneralSettings } from '../settings/store'
import { plural } from '../../shared/plural'
import { isContainerDown } from '../alerts/container-state'
import { containerProjects, missingProjects } from './containers'
import { OPS_REPORT_SCHEMA, type OpsOverallStatus, type OpsReport } from '../../shared/report-contract'

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const r1 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)

async function availability(start: Date, end: Date): Promise<OpsReport['availability']> {
  const db = getDb()
  // Часовые агрегаты: точность периода — до часа, без чтения сырых проверок.
  const rows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      url: monitors.url,
      total: sql<number>`coalesce(sum(${checkRollups.total}), 0)`,
      okCount: sql<number>`coalesce(sum(${checkRollups.okCount}), 0)`,
      latencySum: sql<number>`coalesce(sum(${checkRollups.latencySum}), 0)`,
      latencyCount: sql<number>`coalesce(sum(${checkRollups.latencyCount}), 0)`,
    })
    .from(monitors)
    .leftJoin(
      checkRollups,
      and(
        eq(checkRollups.monitorId, monitors.id),
        eq(checkRollups.grain, 'h'),
        gte(checkRollups.bucketStart, start.getTime()),
        lt(checkRollups.bucketStart, end.getTime()),
      ),
    )
    .groupBy(monitors.id)
    .orderBy(monitors.sortOrder)
    .limit(100)
  return rows.map((r) => {
    const total = Number(r.total)
    return {
      monitor: r.name,
      url: r.url,
      checks: total,
      uptimePct: total ? Math.round((Number(r.okCount) / total) * 10000) / 100 : null,
      avgLatencyMs: Number(r.latencyCount) ? Math.round(Number(r.latencySum) / Number(r.latencyCount)) : null,
    }
  })
}

/**
 * Хосты прошлого сохранённого отчёта — для пропавших стеков (OPS-57). Отчёт не сохраняется, пока собирается, поэтому
 * последняя строка — прошлый. Битое тело — как отчёта нет: сравнение молчит, а не роняет сборку.
 */
async function previousHosts(): Promise<Pick<OpsReport, 'hosts'> | null> {
  const row = await getDb().query.reports.findFirst({ orderBy: desc(reports.createdAt), columns: { payloadJson: true } })
  if (!row) return null
  try {
    const hosts = (JSON.parse(row.payloadJson) as Partial<OpsReport>).hosts
    return Array.isArray(hosts) ? { hosts } : null
  } catch {
    return null
  }
}

async function hostStats(start: Date, end: Date): Promise<OpsReport['hosts']> {
  const db = getDb()
  const [list, previous] = await Promise.all([db.query.agents.findMany({ limit: 50 }), previousHosts()])
  return Promise.all(
    list.map(async (a) => {
      const stat = async (metric: string) =>
        (
          await db
            .select({ a: avg(metricSamples.value), m: max(metricSamples.value) })
            .from(metricSamples)
            .where(
              and(
                eq(metricSamples.agentId, a.id),
                eq(metricSamples.metric, metric),
                gte(metricSamples.createdAt, start),
                lt(metricSamples.createdAt, end),
              ),
            )
        )[0]
      const [cpu, mem, disk] = await Promise.all([stat('cpu_pct'), stat('mem_pct'), stat('disk_pct')])
      const ctrs = await db.query.containers.findMany({ where: eq(containers.agentId, a.id), limit: 250 })
      const projects = containerProjects(ctrs)
      const missing = missingProjects(previous, a.id, projects)
      return {
        agent: a.id,
        name: a.name,
        cpuAvgPct: r1(cpu?.a === null || cpu?.a === undefined ? null : Number(cpu.a)),
        cpuMaxPct: r1(cpu?.m ?? null),
        memAvgPct: r1(mem?.a === null || mem?.a === undefined ? null : Number(mem.a)),
        diskMaxPct: r1(disk?.m ?? null),
        containersNotRunning: ctrs.filter((c) => isContainerDown(c)).map((c) => c.name),
        projects,
        ...(missing.length ? { missingProjects: missing } : {}),
      }
    }),
  )
}

/**
 * Общий статус периода. Открытый инцидент считается сам по себе: заведённый вручную или оставшийся
 * открытым после закрытия алертов — это не «штатно» (активный критичный — critical, прочий незакрытый — degraded).
 */
export function overallStatus(input: {
  criticalOpen: number
  warningOpen: number
  minUptime: number | null
  activeCriticalIncidents?: number
  unresolvedIncidents?: number
}): OpsOverallStatus {
  if (input.criticalOpen > 0 || (input.activeCriticalIncidents ?? 0) > 0 || (input.minUptime !== null && input.minUptime < 99))
    return 'critical'
  if (input.warningOpen > 0 || (input.unresolvedIncidents ?? 0) > 0 || (input.minUptime !== null && input.minUptime < 99.9))
    return 'degraded'
  return 'healthy'
}

export function recommendations(r: Pick<OpsReport, 'hosts' | 'restarts' | 'availability' | 'tls' | 'deploys'>): string[] {
  const out: string[] = []
  for (const h of r.hosts) {
    if (h.diskMaxPct !== null && h.diskMaxPct >= 80)
      out.push(`${h.name}: диск заполнен до ${h.diskMaxPct}% — запланировать очистку или расширение.`)
    if (h.memAvgPct !== null && h.memAvgPct >= 85)
      out.push(`${h.name}: средняя загрузка памяти ${h.memAvgPct}% — проверить лимиты контейнеров.`)
    if (h.containersNotRunning.length) out.push(`${h.name}: не запущены ${h.containersNotRunning.join(', ')}.`)
  }
  const byContainer = new Map<string, number>()
  for (const x of r.restarts) byContainer.set(x.container, (byContainer.get(x.container) ?? 0) + 1)
  for (const [name, n] of byContainer)
    if (n >= 2) out.push(`${name} перезапускали вручную ${plural(n, ['раз', 'раза', 'раз'])} — нужен разбор первопричины, а не очередной рестарт.`)
  for (const a of r.availability)
    if (a.uptimePct !== null && a.uptimePct < 99.5) out.push(`${a.monitor}: доступность ${a.uptimePct}% ниже 99.5%.`)
  for (const t of r.tls)
    if (t.daysLeft !== null && t.daysLeft < 21)
      out.push(`TLS ${t.domain} истекает через ${t.daysLeft} дн. — проверить автопродление certbot.`)
  if (r.deploys.failed > 0) out.push(`Упавших деплоев за период: ${r.deploys.failed}.`)
  return out.slice(0, 12)
}

export async function buildReport(period: 'daily' | 'weekly', end = new Date()): Promise<OpsReport> {
  const db = getDb()
  const start = new Date(end.getTime() - (period === 'daily' ? 1 : 7) * 86_400_000)
  const general = await getGeneralSettings()

  const [avail, hosts, incs, alertRows, openAlerts, restartRows, deployRows, tls] = await Promise.all([
    availability(start, end),
    hostStats(start, end),
    db.query.incidents.findMany({
      where: and(lte(incidents.startedAt, end), or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, start))),
      orderBy: desc(incidents.startedAt),
      limit: 50,
    }),
    db
      .select({ severity: alerts.severity, n: count() })
      .from(alerts)
      .where(and(gte(alerts.startedAt, start), lt(alerts.startedAt, end)))
      .groupBy(alerts.severity),
    // Все горящие (до 100): по ним считаются статус и «горит сейчас» — обрезка до 10 занижала счёт.
    db.query.alerts.findMany({ where: eq(alerts.status, 'firing'), orderBy: desc(alerts.startedAt), limit: 100 }),
    db.query.commands.findMany({
      where: and(gte(commands.requestedAt, start), lt(commands.requestedAt, end)),
      orderBy: desc(commands.requestedAt),
      limit: 50,
    }),
    db.query.deploys.findMany({
      where: and(gte(deploys.createdAt, start), lt(deploys.createdAt, end)),
      orderBy: desc(deploys.createdAt),
      limit: 50,
    }),
    db.query.tlsChecks.findMany({ orderBy: tlsChecks.daysLeft, limit: 50 }),
  ])
  const agentNames = new Map((await db.query.agents.findMany({ limit: 50 })).map((a) => [a.id, a.name]))
  const fired = Object.fromEntries(alertRows.map((r) => [r.severity, r.n])) as Partial<Record<'warning' | 'critical', number>>

  const partial = {
    availability: avail,
    hosts,
    restarts: restartRows.map((c) => ({
      agent: agentNames.get(c.agentId) ?? c.agentId,
      container: c.target,
      at: c.requestedAt.toISOString(),
      by: c.requestedBy,
      reason: c.reason,
      result: c.status,
    })),
    tls: tls.map((t) => ({ domain: t.domain, daysLeft: t.daysLeft, error: t.error })),
    deploys: {
      total: deployRows.length,
      failed: deployRows.filter((d) => d.conclusion === 'failure' || d.conclusion === 'timed_out' || d.conclusion === 'not_started').length,
      recent: deployRows
        .slice(0, 5)
        .map((d) => ({ title: d.title, conclusion: d.conclusion, at: (d.finishedAt ?? d.createdAt).toISOString(), url: d.url })),
    },
  }
  const minUptime = avail.reduce<number | null>(
    (acc, a) => (a.uptimePct === null ? acc : acc === null ? a.uptimePct : Math.min(acc, a.uptimePct)),
    null,
  )
  const criticalOpen = openAlerts.filter((a) => a.severity === 'critical').length
  const status = overallStatus({
    criticalOpen,
    warningOpen: openAlerts.length - criticalOpen,
    minUptime,
    activeCriticalIncidents: incs.filter((i) => i.status === 'active' && i.severity === 'critical').length,
    unresolvedIncidents: incs.filter((i) => i.status !== 'resolved').length,
  })
  const headline =
    status === 'healthy'
      ? 'Системы работают штатно'
      : status === 'degraded'
        ? 'Есть деградация — требуется внимание'
        : 'Есть критичные проблемы'
  const highlights = [
    minUptime !== null ? `Минимальная доступность среди мониторов: ${minUptime}%` : 'Нет данных доступности',
    `Инцидентов за период: ${incs.length}, алертов: ${(fired.critical ?? 0) + (fired.warning ?? 0)}`,
    `Ручных перезапусков: ${restartRows.length}, деплоев: ${deployRows.length}`,
  ]
  return {
    schema: OPS_REPORT_SCHEMA,
    source: { console: general.consoleName, url: getEnv().publicUrl },
    period: { kind: period, start: start.toISOString(), end: end.toISOString() },
    generatedAt: new Date().toISOString(),
    summary: { status, headline, highlights },
    incidents: incs.map((i) => ({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: iso(i.resolvedAt),
      durationMin: i.resolvedAt ? Math.round((i.resolvedAt.getTime() - i.startedAt.getTime()) / 60_000) : null,
    })),
    alerts: {
      fired: (fired.critical ?? 0) + (fired.warning ?? 0),
      critical: fired.critical ?? 0,
      warning: fired.warning ?? 0,
      stillOpen: openAlerts.map((a) => ({ title: a.title, object: a.object, severity: a.severity, since: a.startedAt.toISOString() })),
    },
    ...partial,
    recommendations: recommendations(partial),
  }
}
