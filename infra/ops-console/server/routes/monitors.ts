/** Внешние проверки: мониторы, история, TLS. */
import { Hono } from 'hono'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { checkResults, checkRollups, DNS_RECORDS, MONITOR_TYPES, monitors, tlsChecks } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { assertSafeUrl } from '../lib/http'
import { parseBody, parseId, parseQuery, patchOf } from '../lib/validate'
import { logActivity } from '../activity'
import { parseHostPort, recordCheck, runCheck } from '../monitors/checks'
import { checkTlsCertificates } from '../monitors/tls'
import { monitorUptime } from './overview'
import { getEgressAllowlist } from '../settings/store'
import { serializeMonitor } from './serialize'
import { latencyStats, monitorDetailStats } from '../monitors/stats'
import { activeWindows, windowFor } from '../maintenance/store'
import { maintenanceView } from './maintenance'

const monitorBase = z.object({
  name: z.string().trim().min(1).max(190),
  type: z.enum(MONITOR_TYPES).default('http'),
  /** http — URL; tcp — «хост:порт»; dns — имя хоста. Проверяется вместе с type (addressError). */
  url: z.string().trim().min(1).max(1024),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  expectStatus: z.number().int().min(100).max(599).nullable().default(null),
  expectHealthJson: z.boolean().default(false),
  keyword: z.string().trim().max(200).nullable().default(null),
  dnsRecord: z.enum(DNS_RECORDS).default('A'),
  expectValue: z.string().trim().max(200).nullable().default(null),
  description: z.string().trim().max(190).default(''),
  intervalSec: z.number().int().min(30).max(3600).default(60),
  timeoutMs: z.number().int().min(1000).max(30_000).default(8000),
  tags: z.string().trim().max(190).default(''),
  enabled: z.boolean().default(true),
  isPublic: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
})

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/

/** Адрес под тип проверки; null — годится. */
export function addressError(type: (typeof MONITOR_TYPES)[number], url: string): string | null {
  if (type === 'tcp') return parseHostPort(url) ? null : 'для TCP нужен «хост:порт», например db.example.com:5432'
  if (type === 'dns') return HOSTNAME.test(url) ? null : 'для DNS нужно имя хоста, например app.example.com'
  try {
    assertSafeUrl(url)
    return null
  } catch {
    return 'нужен http(s)-адрес без учётных данных'
  }
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

export const monitorRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await getDb().query.monitors.findMany({ orderBy: [monitors.sortOrder, monitors.id], limit: 100 })
    const ids = rows.map((m) => m.id)
    const [uptime, latency, windows] = await Promise.all([
      monitorUptime(ids),
      latencyStats(ids, Date.now() - 86_400_000, { cache: true }),
      activeWindows(),
    ])
    return c.json({
      monitors: rows.map((m) => ({
        ...serializeMonitor(m),
        latency24h: latency.get(m.id) ?? null,
        maintenance: maintenanceView(windowFor(windows, 'monitor', String(m.id))),
        uptime30d: uptime.daily.get(m.id) ?? [],
        uptime24h: uptime.last24h.get(m.id)?.pct ?? null,
        avgLatency24h: uptime.last24h.get(m.id)?.avgMs ?? null,
      })),
    })
  })
  .get('/tls', async (c) => {
    const rows = await getDb().query.tlsChecks.findMany({ orderBy: asc(tlsChecks.daysLeft), limit: 100 })
    return c.json({ certificates: rows.map((r) => ({ ...r, validTo: ms(r.validTo), checkedAt: r.checkedAt.getTime() })) })
  })
  .post('/tls/check', requireRole('operator'), async (c) => {
    const n = await checkTlsCertificates()
    return c.json({ ok: true, domains: n })
  })
  .get('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    const { hours } = parseQuery(c, z.object({ hours: z.coerce.number().int().min(1).max(720).default(24) }))
    const db = getDb()
    const m = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    if (!m) throw apiError(404, 'Монитор не найден')
    const since = Date.now() - hours * 3_600_000
    const [recent, hourly] = await Promise.all([
      db.query.checkResults.findMany({ where: eq(checkResults.monitorId, id), orderBy: desc(checkResults.createdAt), limit: 60 }),
      db
        .select()
        .from(checkRollups)
        .where(
          and(
            eq(checkRollups.monitorId, id),
            eq(checkRollups.grain, 'h'),
            gte(checkRollups.bucketStart, Math.floor(since / 3_600_000) * 3_600_000),
          ),
        )
        .orderBy(asc(checkRollups.bucketStart))
        .limit(800),
    ])
    const [stats, windows] = await Promise.all([monitorDetailStats(id, since), activeWindows()])
    return c.json({
      monitor: { ...serializeMonitor(m), maintenance: maintenanceView(windowFor(windows, 'monitor', String(m.id))) },
      stats,
      recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })),
      hourly: hourly.map((h) => ({
        t: h.bucketStart,
        total: h.total,
        ok: h.okCount,
        avgMs: h.latencyCount ? Math.round(h.latencySum / h.latencyCount) : null,
      })),
    })
  })
  .post('/', requireRole('operator'), async (c) => {
    const body = await parseBody(c, monitorBase)
    const bad = addressError(body.type, body.url)
    if (bad) throw apiError(400, bad)
    const [row] = await getDb()
      .insert(monitors)
      .values({ ...body, keyword: body.keyword || null, createdAt: new Date() })
      .returning()
    await logActivity('config', `Добавлен монитор «${body.name}»`, c.get('user').email, '/monitoring')
    return c.json({ monitor: row ? serializeMonitor(row) : null }, 201)
  })
  .patch('/:id', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const body = await parseBody(c, patchOf(monitorBase))
    if (body.type !== undefined || body.url !== undefined) {
      const prev = await getDb().query.monitors.findFirst({ where: eq(monitors.id, id) })
      if (!prev) throw apiError(404, 'Монитор не найден')
      const bad = addressError(body.type ?? prev.type, body.url ?? prev.url)
      if (bad) throw apiError(400, bad)
    }
    const [row] = await getDb()
      .update(monitors)
      .set({ ...body, ...(body.keyword !== undefined ? { keyword: body.keyword || null } : {}) })
      .where(eq(monitors.id, id))
      .returning()
    if (!row) throw apiError(404, 'Монитор не найден')
    await logActivity('config', `Изменён монитор «${row.name}»`, c.get('user').email, '/monitoring')
    return c.json({ monitor: serializeMonitor(row) })
  })
  .delete('/:id', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const db = getDb()
    const [row] = await db.delete(monitors).where(eq(monitors.id, id)).returning({ name: monitors.name })
    if (!row) throw apiError(404, 'Монитор не найден')
    await db.delete(checkResults).where(eq(checkResults.monitorId, id))
    await db.delete(checkRollups).where(eq(checkRollups.monitorId, id))
    await logActivity('config', `Удалён монитор «${row.name}»`, c.get('user').email, '/monitoring')
    return c.json({ ok: true })
  })
  .post('/:id/check', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const m = await getDb().query.monitors.findFirst({ where: eq(monitors.id, id) })
    if (!m) throw apiError(404, 'Монитор не найден')
    const out = await runCheck(m, await getEgressAllowlist())
    await recordCheck(m, out)
    return c.json(out)
  })
