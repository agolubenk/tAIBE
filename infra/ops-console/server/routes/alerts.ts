/** Алерты (подтверждение, тишина, ручное закрытие) и правила. */
import { Hono } from 'hono'
import { and, asc, count, desc, eq, gte, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { ALERT_RULE_KINDS, alertNotes, alertRules, alerts, deliveries } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseId, parseQuery, patchOf } from '../lib/validate'
import { logActivity } from '../activity'
import { resolveAlert } from '../alerts/store'
import { ackAlert, addAlertNote, refreshCardsAfterAction, silenceAlert } from '../alerts/actions'
import { serializeAlert } from './serialize'

const listQuery = z.object({
  status: z.enum(['firing', 'resolved', 'all']).default('firing'),
  days: z.coerce.number().int().min(1).max(90).default(7),
  /** Только алерты хоста (страница хоста, вкладка «Алерты»). */
  agent: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
})

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(190),
  kind: z.enum(ALERT_RULE_KINDS),
  agentId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .nullable()
    .default(null),
  metric: z
    .string()
    // Запятая — список сервисов «занят ≠ завис» у правила «Контейнер unhealthy» (diarization,whisper).
    .regex(/^[A-Za-z0-9_.:,-]{1,64}$/, 'метрика: латиница, цифры, _ . : , -')
    .nullable()
    .default(null),
  op: z.enum(['gt', 'lt']).default('gt'),
  threshold: z.number().finite().default(0),
  forSamples: z.number().int().min(1).max(60).default(1),
  severity: z.enum(['warning', 'critical']).default('warning'),
  repeatMin: z.number().int().min(0).max(10_080).default(240),
  enabled: z.boolean().default(true),
})

/**
 * Список через запятую — только у «Контейнер unhealthy» (пакетные сервисы «занят ≠ завис»). У правила по метрике
 * запятая — опечатка: такое правило молча не совпало бы ни с одной метрикой.
 */
function assertMetricList(kind: string, metric: string | null | undefined): void {
  if (metric?.includes(',') && kind !== 'container_unhealthy') {
    throw apiError(400, 'Запятая в поле «метрика» — только у правила «Контейнер unhealthy» (список сервисов)')
  }
}

export const alertRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { status, days, agent } = parseQuery(c, listQuery)
    const since = new Date(Date.now() - days * 86_400_000)
    const byStatus =
      status === 'firing'
        ? eq(alerts.status, 'firing')
        : status === 'resolved'
          ? and(eq(alerts.status, 'resolved'), gte(alerts.startedAt, since))
          : gte(alerts.startedAt, since)
    const where = agent ? and(byStatus, eq(alerts.route, `/infrastructure/${agent}`)) : byStatus
    const rows = await getDb().query.alerts.findMany({ where, orderBy: desc(alerts.startedAt), limit: 100 })
    const notes = rows.length
      ? await getDb()
          .select({ id: alertNotes.alertId, n: count() })
          .from(alertNotes)
          .where(inArray(alertNotes.alertId, rows.map((r) => r.id)))
          .groupBy(alertNotes.alertId)
      : []
    const noteCount = new Map(notes.map((r) => [r.id, r.n]))
    return c.json({ alerts: rows.map((a) => ({ ...serializeAlert(a), notes: noteCount.get(a.id) ?? 0 })) })
  })
  .get('/deliveries', async (c) => {
    const rows = await getDb().query.deliveries.findMany({ orderBy: desc(deliveries.createdAt), limit: 100 })
    return c.json({ deliveries: rows.map((d) => ({ ...d, createdAt: d.createdAt.getTime() })) })
  })
  .post('/:id/ack', requireRole('operator'), async (c) => {
    const done = await ackAlert(parseId(c.req.param('id')), c.get('user').email)
    if (!done) throw apiError(404, 'Активный алерт не найден')
    if (!done.already) await refreshCardsAfterAction(done.row)
    return c.json({ alert: serializeAlert(done.row) })
  })
  /** Заметки дежурных к алерту: «что уже проверили». */
  .get('/:id/notes', async (c) => {
    const id = parseId(c.req.param('id'))
    const rows = await getDb().query.alertNotes.findMany({ where: eq(alertNotes.alertId, id), orderBy: asc(alertNotes.createdAt), limit: 100 })
    return c.json({ notes: rows.map((n) => ({ ...n, createdAt: n.createdAt.getTime() })) })
  })
  .post('/:id/notes', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const { message } = await parseBody(c, z.object({ message: z.string().trim().min(1).max(2000) }))
    const user = c.get('user')
    const alert = await getDb().query.alerts.findFirst({ where: eq(alerts.id, id) })
    if (!alert) throw apiError(404, 'Алерт не найден')
    await addAlertNote(alert, message, user.email)
    return c.json({ ok: true }, 201)
  })
  .post('/:id/silence', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const { minutes, reason } = await parseBody(
      c,
      z.object({ minutes: z.number().int().min(0).max(10_080), reason: z.string().trim().max(500).default('') }),
    )
    const done = await silenceAlert(id, minutes, c.get('user').email)
    if (done && reason) await addAlertNote(done.row, `Тишина ${minutes} мин: ${reason}`, c.get('user').email)
    if (!done) throw apiError(404, 'Активный алерт не найден')
    await refreshCardsAfterAction(done.row)
    return c.json({ alert: serializeAlert(done.row) })
  })
  .post('/:id/resolve', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const user = c.get('user')
    const row = await getDb().query.alerts.findFirst({ where: and(eq(alerts.id, id), eq(alerts.status, 'firing')) })
    if (!row) throw apiError(404, 'Активный алерт не найден')
    // Если условие всё ещё выполняется, следующий отчёт/проверка поднимет алерт снова — это честно.
    await resolveAlert(row, `закрыт вручную (${user.email})`, user.email)
    return c.json({ ok: true })
  })
  .get('/rules', async (c) => {
    const rows = await getDb().query.alertRules.findMany({ orderBy: [alertRules.kind, alertRules.id], limit: 200 })
    return c.json({ rules: rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })) })
  })
  .post('/rules', requireRole('operator'), async (c) => {
    const body = await parseBody(c, ruleSchema)
    if (body.kind === 'host_metric' && !body.metric) throw apiError(400, 'Для правила по метрике укажите метрику')
    assertMetricList(body.kind, body.metric)
    const [row] = await getDb()
      .insert(alertRules)
      .values({ ...body, builtin: false, createdAt: new Date() })
      .returning()
    await logActivity('config', `Правило алерта «${body.name}» создано`, c.get('user').email, '/alerts?tab=rules')
    return c.json({ rule: row }, 201)
  })
  .patch('/rules/:id', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const body = await parseBody(c, patchOf(ruleSchema.omit({ kind: true })))
    if (body.metric?.includes(',')) {
      const current = await getDb().query.alertRules.findFirst({ where: eq(alertRules.id, id), columns: { kind: true } })
      if (current) assertMetricList(current.kind, body.metric)
    }
    const [row] = await getDb().update(alertRules).set(body).where(eq(alertRules.id, id)).returning()
    if (!row) throw apiError(404, 'Правило не найдено')
    await logActivity(
      'config',
      `Правило «${row.name}» изменено${body.enabled === false ? ' (выключено)' : ''}`,
      c.get('user').email,
      '/alerts?tab=rules',
    )
    if (body.enabled === false) {
      // Выключенное правило не должно оставлять «вечно горящие» алерты.
      const open = await getDb().query.alerts.findMany({ where: and(eq(alerts.ruleId, id), eq(alerts.status, 'firing')), limit: 100 })
      for (const a of open) await resolveAlert(a, 'правило выключено', c.get('user').email)
    }
    return c.json({ rule: row })
  })
  .delete('/rules/:id', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const db = getDb()
    const rule = await db.query.alertRules.findFirst({ where: eq(alertRules.id, id) })
    if (!rule) throw apiError(404, 'Правило не найдено')
    if (rule.builtin) throw apiError(409, 'Встроенное правило нельзя удалить — выключите его')
    const open = await db.query.alerts.findMany({ where: and(eq(alerts.ruleId, id), inArray(alerts.status, ['firing'])), limit: 100 })
    for (const a of open) await resolveAlert(a, 'правило удалено', c.get('user').email)
    await db.delete(alertRules).where(eq(alertRules.id, id))
    await logActivity('config', `Правило «${rule.name}» удалено`, c.get('user').email, '/alerts?tab=rules')
    return c.json({ ok: true })
  })
