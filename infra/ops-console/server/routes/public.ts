/**
 * Публичная status-страница: только мониторы с флагом «публичный», без URL, ошибок и хостов.
 * Выключена по умолчанию (Настройки → Общие). История — 90 дней по суточным агрегатам.
 *
 * Инциденты публикуются только через публичные сервисы, которые они задели: «сбой HR Helper
 * application, 14 мин» — без внутренних заголовков, объектов и заметок. Инцидент без публичного
 * сервиса (внутренний хост, ручной) на странице не появляется.
 */
import { Hono } from 'hono'
import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, incidents, monitors } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { getGeneralSettings } from '../settings/store'
import { monitorUptime } from './overview'
import { publicRelease } from './release'

const DAY = 86_400_000
const HISTORY_DAYS = 90

export const publicRoutes = new Hono<AppEnv>().get('/status', async (c) => {
  const general = await getGeneralSettings()
  if (!general.publicStatusEnabled) throw apiError(404, 'Публичная страница статуса выключена')
  const db = getDb()
  const rows = await db.query.monitors.findMany({
    where: and(eq(monitors.isPublic, true), eq(monitors.enabled, true)),
    orderBy: monitors.sortOrder,
    limit: 50,
  })
  const ids = rows.map((m) => m.id)
  const name = new Map(rows.map((m) => [m.id, m.name]))
  const uptime = await monitorUptime(ids, HISTORY_DAYS)
  const firingIds = new Set(
    (await db.select({ route: alerts.route }).from(alerts).where(eq(alerts.status, 'firing')).limit(200))
      .map((a) => /monitor=(\d+)/.exec(a.route)?.[1])
      .filter(Boolean)
      .map(Number),
  )
  // Инциденты за 90 дней, задевшие публичные сервисы: связь — через алерты мониторов.
  const since = new Date(Date.now() - HISTORY_DAYS * DAY)
  const touched = ids.length
    ? await db
        .select({ incidentId: alerts.incidentId, route: alerts.route })
        .from(alerts)
        .where(and(isNotNull(alerts.incidentId), gte(alerts.startedAt, since)))
        .limit(2000)
    : []
  const byIncident = new Map<number, Set<string>>()
  for (const a of touched) {
    const mid = Number(/monitor=(\d+)/.exec(a.route)?.[1])
    const n = name.get(mid)
    if (!n || !a.incidentId) continue
    const set = byIncident.get(a.incidentId) ?? new Set<string>()
    set.add(n)
    byIncident.set(a.incidentId, set)
  }
  const incidentRows = byIncident.size
    ? await db.query.incidents.findMany({ where: inArray(incidents.id, [...byIncident.keys()]), orderBy: desc(incidents.startedAt), limit: 50 })
    : []
  const history = incidentRows.map((i) => ({
    severity: i.severity,
    status: i.status,
    startedAt: i.startedAt.getTime(),
    resolvedAt: i.resolvedAt?.getTime() ?? null,
    services: [...(byIncident.get(i.id) ?? [])],
  }))
  c.header('Cache-Control', 'public, max-age=30')
  return c.json({
    title: general.publicStatusTitle,
    updatedAt: Date.now(),
    services: rows.map((m) => {
      const days = uptime.daily.get(m.id) ?? []
      const measured = days.filter((d) => d.pct !== null)
      return {
        name: m.name,
        description: m.description,
        status: m.lastOk === null ? 'unknown' : !m.lastOk || firingIds.has(m.id) ? 'down' : 'up',
        uptime90d: days,
        uptimePct90: measured.length ? Math.round((measured.reduce((sum, d) => sum + (d.pct ?? 0), 0) / measured.length) * 100) / 100 : null,
        uptime24h: uptime.last24h.get(m.id)?.pct ?? null,
      }
    }),
    incidents: history.filter((i) => i.status !== 'resolved'),
    history,
  })
})
  /** Версия продукта для подвалов (edge nginx `/release.json`): только `{version, setAt}`. */
  .get('/release', publicRelease)
