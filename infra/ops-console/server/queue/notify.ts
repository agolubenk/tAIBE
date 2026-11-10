/**
 * События 2FA платформенных администраторов от backend продукта (#351 PR-2, план
 * docs/plans/roadmap/platform-admin-mfa.md, п. 7 «Канал в консоль»): POST /api/oq/v1/notify с токеном области
 * notify. Консоль отвечает 202 сразу, а доставку делает после ответа: личная Telegram-подписка владельца консоли
 * (server/notify/dispatch.ts) и строка ленты событий. Отказ доставки виден в ленте и журнале доставок консоли,
 * а не у пользователя продукта. Источник правды — строка журнала backend `platform_admin_mfa`.
 *
 * Состояние повторов — в памяти процесса, как ограничения частоты (queue/throttle.ts): консоль одна.
 */
import { isIP } from 'node:net'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../activity'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { broadcast } from '../notify/dispatch'
import { escapeHtml } from '../notify/format'
import { clock } from '../lib/time'
import { getGeneralSettings } from '../settings/store'

/** Имена событий — те же, что в строке журнала backend и в таблице аудита (#351 PR-2). */
export const NOTIFY_EVENTS = ['enabled', 'changed', 'recovery_login', 'reset', 'off', 'on'] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]
/** События учётной записи — с логином; off/on — выключатель требования 2FA для всех, без логина. */
const ACCOUNT_EVENTS: ReadonlySet<NotifyEvent> = new Set(['enabled', 'changed', 'recovery_login', 'reset'])

// Управляющие символы (перевод строки и т. п.) подделали бы строки сообщения владельцу.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const plain = (min: number, max: number) => z.string().min(min).max(max).refine((s) => !CONTROL_RE.test(s), 'управляющие символы')
// toISOString() backend даёт «Z»; смещение «+03:00» тоже принимается.
const isoTime = z.string().max(40).datetime({ offset: true })

export const notifySchema = z
  .object({
    event: z.enum(NOTIFY_EVENTS),
    // Логин — PlatformAdmin.username, backend его набор символов не ограничивает (patch-platform-profile.dto.ts:
    // только @IsString): 400 здесь потерял бы сигнал владельцу. Защита shell — в ownerMessage (SHELL_SAFE_LOGIN).
    login: plain(1, 254).optional(),
    at: isoTime,
    ua: plain(0, 512).optional(),
    ip: z
      .string()
      .max(45)
      .refine((s) => isIP(s) !== 0, 'не IP-адрес')
      .optional(),
    remaining: z.number().int().min(0).max(10).optional(),
    until: isoTime.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const account = ACCOUNT_EVENTS.has(b.event)
    if (account && b.login === undefined) ctx.addIssue({ code: 'custom', path: ['login'], message: 'обязателен для этого события' })
    if (!account && b.login !== undefined) ctx.addIssue({ code: 'custom', path: ['login'], message: 'не передаётся для off и on' })
    if (b.remaining !== undefined && b.event !== 'recovery_login') ctx.addIssue({ code: 'custom', path: ['remaining'], message: 'только для recovery_login' })
    if (b.event === 'off' && b.until === undefined) ctx.addIssue({ code: 'custom', path: ['until'], message: 'обязателен для off' })
    if (b.event !== 'off' && b.until !== undefined) ctx.addIssue({ code: 'custom', path: ['until'], message: 'только для off' })
  })
export type NotifyBody = z.infer<typeof notifySchema>

// ── Повторы: login + event + минута `at` (+ remaining) — одно сообщение ───────

/** Ключ хранится 10 минут с приёма: дольше повтору взяться неоткуда (backend не повторяет запрос). */
const DEDUPE_TTL_MS = 10 * 60_000
const seen = new Map<string, number>()

/**
 * true — событие новое и запомнено; false — повтор, второго сообщения не будет. remaining в ключе: два входа
 * резервными кодами за одну минуту — два настоящих события (7, потом 6 из 10), а не повтор (ревью «Ресурсов»).
 */
export function rememberEvent(b: Pick<NotifyBody, 'event' | 'login' | 'at' | 'remaining'>, now = Date.now()): boolean {
  for (const [k, t] of seen) if (now - t >= DEDUPE_TTL_MS) seen.delete(k)
  const key = `${b.event}\n${b.login ?? ''}\n${Math.floor(Date.parse(b.at) / 60_000)}\n${b.remaining ?? ''}`
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

// ── Текст владельцу (план, п. 7, тексты ревью «Аналитика») ────────────────────

/** «Chrome 131, macOS» из User-Agent; не распознан — начало строки. */
export function shortUa(ua: string): string {
  // Порядок важен: Edge, Opera и Яндекс пишут в UA ещё и «Chrome/», Chrome — ещё и «Safari/».
  const m = ua.match(/\b(Edg|OPR|YaBrowser|Firefox)\/(\d+)/) ?? ua.match(/\b(Chrome)\/(\d+)/)
  const safari = !m && /Safari\//.test(ua) ? ua.match(/\bVersion\/(\d+)/) : null
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera', YaBrowser: 'Яндекс Браузер' }
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  const b = m ? `${names[m[1]!] ?? m[1]} ${m[2]}` : safari ? `Safari ${safari[1]}` : ''
  const label = [b, os].filter(Boolean).join(', ')
  return label || ua.slice(0, 80)
}

function eventText(b: NotifyBody, tz: string, now: number): string {
  switch (b.event) {
    case 'enabled':
      return 'настроена двухфакторная защита (2FA)'
    case 'changed':
      return 'телефон для 2FA заменён'
    case 'recovery_login':
      return b.remaining === undefined ? 'выполнен вход резервным кодом' : `выполнен вход резервным кодом (осталось ${b.remaining} из 10)`
    case 'reset':
      return '2FA сброшена владельцем платформы'
    case 'off':
      return `требование для администраторов снято до ${clock(Date.parse(b.until!), tz, now)} командой на сервере`
    case 'on':
      return `требование для администраторов вернулось в ${clock(Date.parse(b.at), tz, now)}`
  }
}

/**
 * Логин, который можно подставить в команду shell: без $ ` ' " ; ( ) | & < > пробела и т. п. Первый символ — не «-»,
 * чтобы логин не прочитался как опция команды.
 */
const SHELL_SAFE_LOGIN = /^(?!-)[A-Za-z0-9._@+-]{1,254}$/

/**
 * Сброс 2FA на сервере — строка runbook docs/ops/deploy-contabo.md «2FA администратора платформы: сброс» (#554).
 * Отдельной команды platform-admin-mfa на сервере нет: владелец копирует эту строку как есть.
 */
const RESET_CMD = '/opt/hr-helper/infra/scripts/prod/contabo-compose.sh exec -T -w /app/apps/backend backend node dist/scripts/platform-admin-mfa.js --reset'

/** Сообщение владельцу. Все поля тела — экранированы: их прислал процесс, который принимает интернет. */
export function ownerMessage(b: NotifyBody, tz: string, now = Date.now()): { text: string; html: string } {
  const what = eventText(b, tz, now)
  if (!ACCOUNT_EVENTS.has(b.event)) return { text: `2FA: ${what}`, html: escapeHtml(`2FA: ${what}`) }
  const facts = [clock(Date.parse(b.at), tz, now), b.ua ? shortUa(b.ua) : '', b.ip ? `IP ${b.ip}` : ''].filter(Boolean).join(', ')
  const head = `2FA: ${b.login} — ${what}, ${facts}.`
  // После сброса подсказка «сбросьте» бессмысленна: сброс уже сделан командой на сервере.
  if (b.event === 'reset') return { text: head, html: escapeHtml(head) }
  // Команду владелец копирует в shell на сервере (ревью «Контроля», CHANGES-1): подставляем только безопасный логин.
  // Иначе сигнал всё равно уходит, но без готовой команды.
  if (!SHELL_SAFE_LOGIN.test(b.login!)) {
    const tail = 'Если не ожидали — сброс на сервере по строке runbook «2FA администратора платформы: сброс» (docs/ops/deploy-contabo.md); логин в команду не подставлен: в нём особые символы.'
    return { text: `${head} ${tail}`, html: `${escapeHtml(head)} ${escapeHtml(tail)}` }
  }
  // Кавычки — второй слой к набору символов логина.
  const cmd = `${RESET_CMD} '${b.login}'`
  return { text: `${head} Если не ожидали — сброс на сервере: ${cmd}`, html: `${escapeHtml(head)} Если не ожидали — сброс на сервере: <code>${escapeHtml(cmd)}</code>` }
}

// ── Доставка после ответа ────────────────────────────────────────────────────

const inflight = new Set<Promise<void>>()

/** Тестам: дождаться доставок, запущенных после ответа 202. */
export async function settleNotifyForTests(): Promise<void> {
  await Promise.all([...inflight])
}

async function deliver(b: NotifyBody, actor: string): Promise<void> {
  const subject = b.login ? `2FA: ${b.login} — ${b.event}` : `2FA: ${b.event}`
  const what = b.login ? `«${b.event}» для ${b.login}` : `«${b.event}»`
  try {
    const owners = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'owner'), eq(users.disabled, false)))
      .limit(20)
    const ownerIds = new Set(owners.map((o) => o.id))
    const { timezone } = await getGeneralSettings()
    const { text, html } = ownerMessage(b, timezone)
    // Только личные подписки владельца: в группах каналов бывают наблюдатели, а в тексте — логин и IP.
    const res = await broadcast(
      'alert',
      // payload читают только webhook-каналы, а их здесь нет; IP и браузер — всё равно только в тексте владельцу.
      { subject, text, html, payload: { type: 'platform_admin_mfa', event: b.event, login: b.login, at: b.at, remaining: b.remaining, until: b.until } },
      null,
      (sub) => ownerIds.has(sub.userId),
    )
    const outcome =
      res.targets === 0
        ? 'не доставлено: у владельца нет действующей Telegram-подписки в боте консоли'
        : res.delivered === res.targets
          ? 'доставлено владельцу в Telegram'
          : `доставлено ${res.delivered} из ${res.targets}: ${(res.errors[0] ?? '').slice(0, 200)}`
    await logActivity('auth', `2FA-событие ${what}: ${outcome}`, actor)
  } catch (err) {
    await logActivity('auth', `2FA-событие ${what}: не доставлено — ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, actor)
  }
}

/** Принять событие: false — повтор (тот же login + event + минута + remaining). Доставка идёт после ответа. */
export function acceptNotify(b: NotifyBody, actor: string): boolean {
  if (!rememberEvent(b)) return false
  const p = deliver(b, actor).finally(() => inflight.delete(p))
  inflight.add(p)
  return true
}
