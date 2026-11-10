/**
 * Рассылка уведомлений: каналы (Telegram-группы, email, webhook) и личные Telegram-подписки
 * админов — с учётом порога важности. Каждая попытка — строка в deliveries; сбой одного
 * получателя не мешает остальным.
 *
 * Telegram — ветками: срабатывание (или «мигает») — карточка, всё дальнейшее по тому же алерту
 * (повтор, восстановление, ручное закрытие, «стабильно») — короткий ответ на неё, а сама
 * карточка переписывается на месте под актуальный статус. Нет карточки (сообщение до этой
 * версии, сбой доставки) — как раньше, полным отдельным сообщением.
 *
 * Личная подписка получает уведомления, только пока доставляема (isDeliverable: учётка активна,
 * доступ из платформы подтверждён, текущий пароль бота введён). Бот заблокирован или чат исчез —
 * подписка останавливается, а не копит ошибки.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { channels, deliveries, type ChannelKind } from '../db/schema'
import { decryptJson } from '../lib/crypto'
import { getEnv } from '../env'
import { SENDERS, editTelegram, messageIdInChat, telegramChatId, type OutgoingMessage } from './senders'
import {
  THREAD_ROOT_EVENTS,
  alertCardHtml,
  alertHtml,
  alertReplyHtml,
  alertSubject,
  alertText,
  type AlertMessage,
} from './format'
import { TelegramError } from '../telegram/api'
import { botToken, getBot, webhookMode, type BotRow } from '../telegram/store'
import {
  deliverableSubscriptions,
  noteDeliveryFailure,
  noteDeliverySuccess,
  type Subscription,
} from '../telegram/subscriptions'

type DeliveryKind = (typeof deliveries.$inferInsert)['kind']
type ChannelRow = typeof channels.$inferSelect

const SEVERITY_RANK = { warning: 0, critical: 1 } as const

/** Получатель уведомления: канал или личная подписка. */
interface Target {
  kind: ChannelKind
  name: string
  config: Record<string, unknown>
  secret: Record<string, string>
  minSeverity: 'warning' | 'critical'
  channel?: ChannelRow
  sub?: Subscription
  /** Кнопки с callback дойдут до консоли: это бот консоли (подписка или канал с тем же токеном). */
  callbacks: boolean
}

function channelTarget(ch: ChannelRow, botTokenOfConsole: string | null = null): Target {
  const secret = decryptJson(ch.secretEnc)
  return {
    kind: ch.kind as ChannelKind,
    name: ch.name,
    config: JSON.parse(ch.configJson) as Record<string, unknown>,
    secret,
    minSeverity: ch.minSeverity,
    channel: ch,
    // Кнопки — только если нажатие опознается: числовой chat id (как его присылает Telegram), а не
    // «@канал» (нажатие придёт с числовым id, и консоль не узнает в нём свой канал).
    callbacks:
      ch.kind === 'telegram' &&
      Boolean(botTokenOfConsole) &&
      secret.botToken === botTokenOfConsole &&
      /^-?\d+$/.test(String((JSON.parse(ch.configJson) as { chatId?: unknown }).chatId ?? '')),
  }
}

async function consoleBotToken(): Promise<string | null> {
  const bot = await getBot()
  return bot ? botToken(bot) : null
}

/**
 * Кнопки под карточкой алерта: «Беру в работу» и «Тишина 1 ч» — пока горит и только там, где
 * нажатие дойдёт до консоли; «Открыть в консоли» — при публичном https-адресе.
 */
function alertKeyboard(m: AlertMessage, t: Target): Record<string, unknown> | undefined {
  if (t.kind !== 'telegram') return undefined
  const rows: Array<Array<Record<string, string>>> = []
  const firing = m.event === 'firing' || m.event === 'repeat' || m.event === 'flapping'
  if (firing && t.callbacks) {
    const now = m.now ?? Date.now()
    const actions: Array<Record<string, string>> = []
    if (!m.acknowledgedBy) actions.push({ text: '✋ Беру в работу', callback_data: `al:ack:${m.alertId}` })
    // Тишина уже на ~час и дольше — кнопка ничего не добавит.
    if (!m.silencedUntil || m.silencedUntil < now + 55 * 60_000) actions.push({ text: '🔕 Тишина 1 ч', callback_data: `al:mute:${m.alertId}` })
    if (actions.length) rows.push(actions)
  }
  // «Подробнее» — карточка алерта из меню бота (инцидент, сервер, действия) новым сообщением.
  const details = t.callbacks ? [{ text: '📋 Подробнее', callback_data: `mo:a:${m.alertId}` }] : []
  const link = webhookMode() && /^https:\/\//.test(m.link) ? [{ text: '🔗 В консоли', url: m.link }] : []
  if (details.length || link.length) rows.push([...details, ...link])
  return rows.length ? { inline_keyboard: rows } : undefined
}

function subscriptionTarget(sub: Subscription, bot: BotRow, token: string): Target {
  return {
    kind: 'telegram',
    // Получателям журнала доставки (видят и наблюдатели) — без Telegram-аккаунта админа.
    name: `личная подписка #${sub.id}`,
    config: { chatId: sub.chatId, refScope: `${bot.botId}/${sub.chatId}` },
    secret: { botToken: token },
    minSeverity: sub.minSeverity,
    sub,
    callbacks: true,
  }
}

async function subscriptionTargets(filter: (sub: Subscription) => boolean = () => true): Promise<Target[]> {
  const bot = await getBot()
  if (!bot) return []
  const subs = await deliverableSubscriptions(bot)
  if (!subs.length) return []
  const token = botToken(bot)
  return subs.filter((s) => filter(s.sub)).map((s) => subscriptionTarget(s.sub, bot, token))
}

async function deliverToTarget(
  t: Target,
  msg: OutgoingMessage,
  kind: DeliveryKind,
  alertId: number | null = null,
): Promise<{ ok: boolean; error: string | null }> {
  const db = getDb()
  let error: string | null = null
  let unreachable = false
  let externalId: string | null = null
  try {
    externalId = await SENDERS[t.kind](t.config, t.secret, msg)
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500)
    unreachable = err instanceof TelegramError && err.unreachable
  }
  const at = new Date()
  // id храним только у карточки (не у ответов в ветке): когда очистка журнала (30 дн.) удалит
  // карточку долгого алерта, корнем не должен стать однострочный ответ — уйдёт новая карточка.
  await db.insert(deliveries).values({
    channelId: t.channel?.id ?? null,
    subscriptionId: t.sub?.id ?? null,
    target: t.name,
    kind,
    alertId,
    ok: !error,
    error,
    externalId: msg.replyTo ? null : externalId,
    createdAt: at,
  })
  if (t.channel) {
    await db
      .update(channels)
      .set(error ? { lastError: error, lastErrorAt: at } : { lastOkAt: at, lastError: null })
      .where(eq(channels.id, t.channel.id))
  } else if (t.sub) {
    if (error) await noteDeliveryFailure(t.sub, error, unreachable)
    else await noteDeliverySuccess(t.sub.id)
  }
  return { ok: !error, error }
}

export function deliverToChannel(
  channel: ChannelRow,
  msg: OutgoingMessage,
  kind: DeliveryKind,
  alertId: number | null = null,
): Promise<{ ok: boolean; error: string | null }> {
  return deliverToTarget(channelTarget(channel), msg, kind, alertId)
}

async function alertTargets(m: AlertMessage): Promise<Target[]> {
  const all = await getDb().query.channels.findMany({ where: eq(channels.enabled, true), limit: 50 })
  const token = await consoleBotToken()
  const targets = [...all.map((ch) => channelTarget(ch, token)), ...(await subscriptionTargets())]
  return targets.filter((t) => SEVERITY_RANK[m.severity] >= SEVERITY_RANK[t.minSeverity])
}

export async function notifyAlert(m: AlertMessage): Promise<number> {
  const targets = await alertTargets(m)
  const msg: OutgoingMessage = {
    subject: alertSubject(m),
    text: alertText(m),
    html: alertHtml(m),
    payload: {
      type: 'alert',
      event: m.event,
      alertId: m.alertId,
      severity: m.severity,
      title: m.title,
      object: m.object,
      value: m.value,
      detail: m.detail,
      facts: Object.fromEntries(m.facts),
      hint: m.hint,
      links: Object.fromEntries(m.links),
      link: m.link,
      incidentId: m.incidentId,
      startedAt: new Date(m.startedAt).toISOString(),
      resolvedAt: m.resolvedAt ? new Date(m.resolvedAt).toISOString() : null,
      resolution: m.resolution || null,
      closedBy: m.closedBy,
      flapCount: m.flapCount ?? null,
    },
  }
  const kind = m.event === 'resolved' || m.event === 'closed' || m.event === 'stable' ? 'resolved' : 'alert'
  const results = await Promise.all(targets.map((t) => deliverAlert(t, m, msg, kind)))
  return results.filter((r) => r.ok).length
}

/** Переписать карточки алерта у всех Telegram-получателей без ответа в ветку (тихое закрытие). */
export async function refreshAlertCards(m: AlertMessage): Promise<void> {
  const targets = (await alertTargets(m)).filter((t) => t.kind === 'telegram')
  await Promise.all(
    targets.map(async (t) => {
      const root = await threadRoot(t, m.alertId)
      if (root) await refreshCard(t, root, m)
    }),
  )
}

async function deliverAlert(t: Target, m: AlertMessage, full: OutgoingMessage, kind: DeliveryKind) {
  const card = { ...full, replyMarkup: alertKeyboard(m, t) }
  if (t.kind !== 'telegram' || THREAD_ROOT_EVENTS.has(m.event)) return deliverToTarget(t, card, kind, m.alertId)
  const root = await threadRoot(t, m.alertId)
  if (!root) return deliverToTarget(t, card, kind, m.alertId)
  const res = await deliverToTarget(t, { ...full, html: alertReplyHtml(m), replyTo: root }, kind, m.alertId)
  // Ответ не ушёл (чаще всего 429 при шторме) — правка карточки только потратила бы лимит чата.
  // «Стабильно» — про серию срабатываний; карточку своего алерта закрытие уже переписало в итог
  // (в том числе молча, пока алерт мигал — resolveAlert → refreshAlertCards).
  if (res.ok && m.event !== 'stable') await refreshCard(t, root, m)
  return res
}

/**
 * Первое доставленное получателю сообщение по алерту — карточка и корень ветки. Только если оно
 * в том же пространстве (чат канала; бот и чат подписки): после смены чата или бота ветка
 * начинается заново.
 */
async function threadRoot(t: Target, alertId: number): Promise<number | null> {
  const owner = t.channel ? eq(deliveries.channelId, t.channel.id) : eq(deliveries.subscriptionId, t.sub?.id ?? -1)
  const row = await getDb().query.deliveries.findFirst({
    where: and(owner, eq(deliveries.alertId, alertId), eq(deliveries.kind, 'alert'), eq(deliveries.ok, true), isNotNull(deliveries.externalId)),
    orderBy: asc(deliveries.id),
    columns: { externalId: true },
  })
  if (!row?.externalId) return null
  return messageIdInChat(row.externalId, telegramChatId(t.config))
}

/** Переписать карточку под текущий статус. Косметика: сбой не мешает ответу и не красит канал. */
async function refreshCard(t: Target, messageId: number, m: AlertMessage): Promise<void> {
  try {
    await editTelegram(t.config, t.secret, messageId, alertCardHtml(m), alertKeyboard(m, t))
  } catch (err) {
    console.warn(`[notify] карточку алерта #${m.alertId} у «${t.name}» не обновить: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Рассылка вне алертов (дайджест, тест, служебное). subscriptions — каким личным подпискам
 * слать (по умолчанию никаким: служебные сообщения о самом боте в бот не идут). Итог — сколько получателей,
 * сколько доставлено и ошибки: вызывающий пишет его в журнал, если отказ доставки должен быть виден.
 * filter null — каналы не нужны, их строки не читаются.
 */
export async function broadcast(
  kind: 'digest' | 'test' | 'alert',
  msg: OutgoingMessage,
  filter: ((ch: ChannelRow) => boolean) | null,
  subscriptions?: (sub: Subscription) => boolean,
): Promise<{ targets: number; delivered: number; errors: string[] }> {
  const picked = filter ? (await getDb().query.channels.findMany({ where: eq(channels.enabled, true), limit: 50 })).filter(filter) : []
  const token = await consoleBotToken()
  const targets = [...picked.map((ch) => channelTarget(ch, token)), ...(subscriptions ? await subscriptionTargets(subscriptions) : [])]
  // Кнопки с callback — только туда, где их нажатие дойдёт до консоли.
  const markupFor = (t: Target) => {
    if (!msg.replyMarkup || t.callbacks) return msg.replyMarkup
    const rows = (msg.replyMarkup.inline_keyboard as Array<Array<Record<string, string>>> | undefined) ?? []
    const kept = rows.map((r) => r.filter((b) => !b.callback_data)).filter((r) => r.length)
    return kept.length ? { inline_keyboard: kept } : undefined
  }
  const results = await Promise.all(targets.map((t) => deliverToTarget(t, { ...msg, replyMarkup: markupFor(t) }, kind)))
  return {
    targets: targets.length,
    delivered: results.filter((r) => r.ok).length,
    errors: results.flatMap((r) => (r.error ? [r.error] : [])),
  }
}

export function consoleLink(route: string): string {
  return `${getEnv().publicUrl}${route.startsWith('/') ? route : `/${route}`}`
}
