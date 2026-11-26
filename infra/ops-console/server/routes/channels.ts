/** Каналы уведомлений (Telegram, email, webhook с HMAC): управление — только владелец. */
import { Hono } from 'hono'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { CHANNEL_KINDS, channels, deliveries, type ChannelKind } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { decryptJson, encryptJson } from '../lib/crypto'
import { parseBody, parseId, patchOf } from '../lib/validate'
import { logActivity } from '../activity'
import { channelConfigSchemas, channelSecretFields, channelSecretSchema } from '../notify/channel-config'
import { deliverToChannel } from '../notify/dispatch'
import { escapeHtml } from '../notify/format'
import { discoverTelegramChats } from '../notify/telegram-discover'
import { serializeChannel } from './serialize'

const baseSchema = z.object({
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().trim().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: channelSecretSchema.default({}),
  minSeverity: z.enum(['warning', 'critical']).default('warning'),
  digest: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

function validateConfig(kind: ChannelKind, config: Record<string, unknown>): Record<string, unknown> {
  const parsed = channelConfigSchemas[kind].safeParse(config)
  if (!parsed.success) throw apiError(400, parsed.error.issues[0]?.message ?? 'Некорректная настройка канала')
  return parsed.data as Record<string, unknown>
}

/** Пустое поле секрета = оставить прежнее значение (форма не видит секретов, только маски). */
/**
 * Куда уходит секрет канала. Сменился адрес — прежний секрет не переносится: иначе SMTP-пароль
 * ушёл бы на новый сервер в открытом виде. Токен Telegram всегда идёт только на api.telegram.org.
 */
const SECRET_DESTINATION: Record<ChannelKind, (config: Record<string, unknown>) => string> = {
  telegram: () => 'api.telegram.org',
  email: (c) => `${String(c.host ?? '')}:${String(c.port ?? '')}:${String(c.user ?? '')}`,
  webhook: (c) => String(c.url ?? ''),
}

function mergeSecrets(kind: ChannelKind, prev: Record<string, string>, next: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of channelSecretFields[kind]) {
    const v = next[field]?.trim()
    if (v) out[field] = v
    else if (prev[field]) out[field] = prev[field]
  }
  return out
}

/**
 * Последняя проверка (тест) и последняя реальная доставка канала — раздельно: «тест прошёл»
 * не значит, что алерты доходят, и наоборот (как в прототипе: статус — по реальной попытке).
 */
async function lastDeliveries(ids: number[]): Promise<Map<number, { lastTestAt: number | null; lastTestOk: boolean | null; lastDeliveryAt: number | null; lastDeliveryOk: boolean | null }>> {
  const out = new Map<number, { lastTestAt: number | null; lastTestOk: boolean | null; lastDeliveryAt: number | null; lastDeliveryOk: boolean | null }>()
  if (!ids.length) return out
  const db = getDb()
  const pick = async (id: number, test: boolean) =>
    db.query.deliveries.findFirst({
      where: and(eq(deliveries.channelId, id), test ? eq(deliveries.kind, 'test') : ne(deliveries.kind, 'test')),
      orderBy: desc(deliveries.id),
      columns: { createdAt: true, ok: true },
    })
  await Promise.all(
    ids.map(async (id) => {
      const [t, d] = await Promise.all([pick(id, true), pick(id, false)])
      out.set(id, {
        lastTestAt: t?.createdAt.getTime() ?? null,
        lastTestOk: t?.ok ?? null,
        lastDeliveryAt: d?.createdAt.getTime() ?? null,
        lastDeliveryOk: d?.ok ?? null,
      })
    }),
  )
  return out
}

export const channelRoutes = new Hono<AppEnv>()
  // Поиск chat id: токен из формы или сохранённый в канале. Боту нужно сперва написать (/start)
  // или добавить его в группу — getUpdates видит только чаты, где бот получил сообщение.
  .post('/telegram/discover', requireRole('owner'), async (c) => {
    const body = await parseBody(
      c,
      z.object({ botToken: z.string().trim().max(256).default(''), channelId: z.number().int().positive().optional() }),
    )
    let token = body.botToken
    if (!token && body.channelId) {
      const ch = await getDb().query.channels.findFirst({ where: eq(channels.id, body.channelId) })
      token = ch?.kind === 'telegram' ? (decryptJson(ch.secretEnc).botToken ?? '') : ''
    }
    if (!token) throw apiError(400, 'Укажите токен бота')
    return c.json(await discoverTelegramChats(token))
  })
  .get('/', requireRole('operator'), async (c) => {
    const rows = await getDb().query.channels.findMany({ orderBy: asc(channels.id), limit: 50 })
    const last = await lastDeliveries(rows.map((r) => r.id))
    return c.json({ channels: rows.map((ch) => ({ ...serializeChannel(ch), ...last.get(ch.id) })) })
  })
  .post('/', requireRole('owner'), async (c) => {
    const body = await parseBody(c, baseSchema)
    const config = validateConfig(body.kind, body.config)
    const secrets = mergeSecrets(body.kind, {}, body.secrets)
    if (body.kind === 'webhook' && !secrets.signingSecret) throw apiError(400, 'Webhook без ключа подписи HMAC не создаётся')
    if (body.kind === 'telegram' && !secrets.botToken) throw apiError(400, 'Нужен токен бота')
    const [row] = await getDb()
      .insert(channels)
      .values({
        kind: body.kind,
        name: body.name,
        configJson: JSON.stringify(config),
        secretEnc: Object.keys(secrets).length ? encryptJson(secrets) : null,
        minSeverity: body.minSeverity,
        digest: body.digest,
        enabled: body.enabled,
        createdAt: new Date(),
      })
      .returning()
    await logActivity('config', `Добавлен канал «${body.name}» (${body.kind})`, c.get('user').email, '/alerts?tab=channels')
    return c.json({ channel: row ? serializeChannel(row) : null }, 201)
  })
  .patch('/:id', requireRole('owner'), async (c) => {
    const id = parseId(c.req.param('id'))
    const db = getDb()
    const prev = await db.query.channels.findFirst({ where: eq(channels.id, id) })
    if (!prev) throw apiError(404, 'Канал не найден')
    const body = await parseBody(c, patchOf(baseSchema.omit({ kind: true })))
    const kind = prev.kind as ChannelKind
    const patch: Partial<typeof channels.$inferInsert> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.minSeverity !== undefined) patch.minSeverity = body.minSeverity
    if (body.digest !== undefined) patch.digest = body.digest
    if (body.enabled !== undefined) patch.enabled = body.enabled
    const prevConfig = JSON.parse(prev.configJson) as Record<string, unknown>
    const nextConfig = body.config !== undefined ? validateConfig(kind, body.config) : prevConfig
    if (body.config !== undefined) patch.configJson = JSON.stringify(nextConfig)
    const prevSecrets = decryptJson(prev.secretEnc)
    const destinationChanged = SECRET_DESTINATION[kind](prevConfig) !== SECRET_DESTINATION[kind](nextConfig)
    if (destinationChanged) {
      const missing = channelSecretFields[kind].filter((f) => prevSecrets[f] && !body.secrets?.[f]?.trim())
      if (missing.length)
        throw apiError(400, 'Адрес канала изменился — введите пароль или ключ подписи заново: прежний секрет не переносится на новый адрес')
    }
    if (body.secrets !== undefined || destinationChanged) {
      const merged = mergeSecrets(kind, destinationChanged ? {} : prevSecrets, body.secrets ?? {})
      patch.secretEnc = Object.keys(merged).length ? encryptJson(merged) : null
    }
    const [row] = await db.update(channels).set(patch).where(eq(channels.id, id)).returning()
    await logActivity('config', `Изменён канал «${row?.name ?? prev.name}»`, c.get('user').email, '/alerts?tab=channels')
    return c.json({ channel: row ? serializeChannel(row) : null })
  })
  .delete('/:id', requireRole('owner'), async (c) => {
    const id = parseId(c.req.param('id'))
    const [row] = await getDb().delete(channels).where(eq(channels.id, id)).returning({ name: channels.name })
    if (!row) throw apiError(404, 'Канал не найден')
    await logActivity('config', `Удалён канал «${row.name}»`, c.get('user').email, '/alerts?tab=channels')
    return c.json({ ok: true })
  })
  .post('/:id/test', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const ch = await getDb().query.channels.findFirst({ where: eq(channels.id, id) })
    if (!ch) throw apiError(404, 'Канал не найден')
    const text = `✅ HR Helper Ops: тестовое сообщение — канал «${ch.name}» работает (${c.get('user').email})`
    const res = await deliverToChannel(
      ch,
      {
        subject: 'HR Helper Ops: тест канала',
        text,
        html: escapeHtml(text),
        payload: { type: 'test', channel: ch.name, at: new Date().toISOString() },
      },
      'test',
    )
    return c.json(res, res.ok ? 200 : 502)
  })
