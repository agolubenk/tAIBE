/**
 * Отчёты и кнопки в Telegram: суточный отчёт с кнопками, «Подробнее», «Графики» (PNG альбомом),
 * «Срочный отчёт», /report и /charts, «Беру в работу» / «Тишина» под карточкой алерта — с проверкой
 * прав (подписчик с паролем, роль оператора) и лимитом частоты.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { eq } from 'drizzle-orm'
import { api, freshApp, login } from './helpers'
import { getDb } from '../server/db/client'
import { agents, alerts, channels, containers, loginAttempts, metricSamples, users } from '../server/db/schema'
import { encryptJson, hashPassword } from '../server/lib/crypto'
import { setEnvForTests } from '../server/env'
import { signInitData } from '../server/telegram/initdata'
import { observe } from '../server/alerts/store'
import { chartSvg, renderPng, resetSnapshotCacheForTests } from '../server/reports/charts'
import { digestHtml, detailHtmlParts, packMessages, reportKeyboard } from '../server/reports/telegram'
import { buildReport } from '../server/reports/build'
import * as http from '../server/lib/http'
import { setTelegramSyncForTests } from '../server/telegram/actions'

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ADMIN_TG = 5001
const PW = 'correct-horse-battery'

type Call = { method: string; body: Record<string, any>; multipart: boolean; bytes: number }
let app: Awaited<ReturnType<typeof freshApp>>
let calls: Call[]
let spy: MockInstance<typeof http.httpRequest>
let secret = ''
let updateId = 1
let msgId = 1000

beforeEach(async () => {
  setTelegramSyncForTests(true)
  resetSnapshotCacheForTests()
  app = await freshApp()
  setEnvForTests({ publicUrl: 'https://ops.example.com', publicUrlExplicit: true })
  calls = []
  spy = vi.spyOn(http, 'httpRequest').mockImplementation(async (url, opts) => {
    const method = url.split('/').at(-1) ?? ''
    const raw = opts?.body
    const multipart = Buffer.isBuffer(raw)
    let body: Record<string, any> = {}
    if (!multipart) body = JSON.parse(String(raw ?? '{}'))
    calls.push({ method, body, multipart, bytes: multipart ? (raw as Buffer).length : 0 })
    let result: unknown = true
    if (method === 'getMe') result = { id: 123456789, username: 'ops_test_bot' }
    if (method === 'getWebhookInfo') result = { url: '' }
    if (method === 'setWebhook') secret = body.secret_token
    if (method === 'sendMessage') result = { message_id: msgId++ }
    if (method === 'sendMediaGroup') result = [{ message_id: msgId++ }]
    return { status: 200, ok: true, text: JSON.stringify({ ok: true, result }), latencyMs: 1 }
  })
})
afterEach(() => {
  spy.mockRestore()
  setEnvForTests({ publicUrl: 'http://ops.test', publicUrlExplicit: false })
})

async function hook(update: Record<string, unknown>) {
  return app.request('/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  })
}
const pm = (tg: number, text: string) => ({ message: { message_id: 1, chat: { id: tg, type: 'private' }, from: { id: tg, is_bot: false }, text } })
const press = (tg: number, data: string, chat = tg) => ({
  callback_query: { id: `cq${updateId}`, from: { id: tg }, message: { message_id: 77, chat: { id: chat, type: chat === tg ? 'private' : 'supergroup' } }, data },
})

/** Владелец, бот, пароль; оператор Anna — активная подписка. */
async function setupActive(role: 'operator' | 'viewer' = 'operator') {
  const owner = api(app, await login(app))
  await owner.put('/telegram/bot', { token: TOKEN })
  await owner.put('/telegram/bot/password', { password: PW })
  await getDb().insert(users).values({ email: 'anna@ops.test', name: 'Anna', role, passwordHash: await hashPassword('anna-password-123'), createdAt: new Date() })
  const anna = api(app, await login(app, 'anna@ops.test', 'anna-password-123'))
  const link = await anna.post('/telegram/me/link')
  await hook(pm(ADMIN_TG, `/start ${String(link.json.url).split('start=')[1]}`))
  const code = /<code>(\d{3}) (\d{3})<\/code>/.exec(String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text))!
  await anna.post('/telegram/me/confirm', { code: code[1]! + code[2]! })
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ADMIN_TG }) }, TOKEN)
  const res = await app.request('/api/telegram/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, password: PW }) })
  expect(res.status).toBe(200)
  calls.splice(0)
  return { owner, anna }
}

async function seedMetrics(metrics = ['cpu_pct', 'mem_pct', 'disk_pct']) {
  await getDb().insert(agents).values({ id: 'prod', name: 'Contabo · prod', environment: 'production', secretEnc: 'x', secretHint: 'x', createdAt: new Date() })
  const now = Date.now()
  for (const metric of metrics) {
    await getDb()
      .insert(metricSamples)
      .values(Array.from({ length: 48 }, (_, i) => ({ agentId: 'prod', metric, value: 20 + (i % 10), createdAt: new Date(now - i * 30 * 60_000) })))
  }
}

describe('формат отчётов', () => {
  it('базовый отчёт — одна карточка с ключевыми цифрами; подробный режется по разделам', async () => {
    await seedMetrics()
    const r = await buildReport('daily')
    const html = digestHtml(r, 'Europe/Minsk')
    expect(html).toMatch(/📊 <b>.* · суточный отчёт<\/b>/)
    for (const s of ['🌐 Доступность', '🚨 Инциденты', '🖥 Ресурсы: CPU пик', '📦 Контейнеры', '🚀 Деплои']) expect(html).toContain(s)
    // Статус не повторяет сам себя, RAM без данных не считается нулём.
    expect(html).not.toMatch(/деградация — Есть деградация/)
    expect(html).toMatch(/RAM до \d/)
    const parts = detailHtmlParts(r, 'Europe/Minsk')
    expect(parts.every((p) => p.length <= 3800)).toBe(true)
    expect(parts.join('\n')).toContain('🖥 <b>Серверы</b>')
    const kb = reportKeyboard(r).inline_keyboard as Array<Array<{ callback_data: string }>>
    expect(kb.flat().map((b) => b.callback_data)).toEqual([expect.stringMatching(/^rep:more:\d+$/), expect.stringMatching(/^rep:charts:\d+$/), 'rep:now', 'mo:home'])
    expect(JSON.stringify(kb)).toContain('Больше информации')
    expect(kb.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true)
  })

  it('контейнеры в отчёте по стекам: стек продукта первым, упавший соседний назван (OPS-8)', async () => {
    await seedMetrics(['cpu_pct'])
    const base = { agentId: 'prod', image: 'x', health: 'none', restartCount: 0, updatedAt: new Date() }
    await getDb()
      .insert(containers)
      .values([
        { ...base, name: 'backend-api-1', state: 'running', composeProject: 'backend', mainStack: true },
        { ...base, name: 'tb-api-1', state: 'restarting', restartPolicy: 'always', composeProject: 't-boards', mainStack: false },
        { ...base, name: 'tb-web-1', state: 'exited', restartPolicy: 'unless-stopped', exitCode: 143, composeProject: 't-boards', mainStack: false },
      ])
    const r = await buildReport('daily')
    expect(r.hosts[0]!.projects).toEqual([
      { name: 'backend', main: true, total: 1, down: [] },
      { name: 't-boards', main: false, total: 2, down: ['tb-api-1'] },
    ])
    expect(digestHtml(r, 'Europe/Minsk')).toContain('📦 Контейнеры: не работают — t-boards: tb-api-1 · 2 стека: backend 1, t-boards 2')
    expect(detailHtmlParts(r, 'Europe/Minsk').join('\n')).toContain('· стеки: backend 1, t-boards 2 (не работают: tb-api-1)')
  })

  it('подробный отчёт: длинные строки не рвут разметку, сообщения ≤ 3800', () => {
    const long = `• <b>${'x'.repeat(5000)}</b>`
    const parts = packMessages([['🖥 <b>Серверы</b>', ...Array.from({ length: 60 }, (_, i) => `• <b>host-${i}</b>: ${'y'.repeat(90)} &amp; z`)], ['🔒 <b>TLS</b>', long]])
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3800)
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length)
      expect(p).not.toMatch(/&[a-z]*$/)
    }
  })

  it('снимок графика — PNG', () => {
    const now = Date.now()
    const png = renderPng(chartSvg({ title: 'CPU, %', unit: '%', yMax: 100, timeZone: 'UTC', from: now - 86_400_000, to: now, series: [{ label: 'prod', color: '#2563EB', points: [[now - 3600_000, 10], [now, 30]] }] }))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
})

describe('кнопки и команды', () => {
  it('суточный отчёт подписчику — с кнопками; каналу с чужим ботом — без callback-кнопок', async () => {
    const { anna } = await setupActive()
    await anna.patch('/telegram/me', { digest: true })
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'другой бот', configJson: JSON.stringify({ chatId: '-100500' }), secretEnc: encryptJson({ botToken: '999:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }), digest: true, createdAt: new Date() })
    calls.splice(0)
    const { sendDailyDigest } = await import('../server/reports/deliver')
    await sendDailyDigest()
    const toAnna = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))!
    expect(JSON.stringify(toAnna.body.reply_markup)).toContain('rep:charts')
    const toGroup = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '-100500')!
    expect(toGroup.body.reply_markup).toBeUndefined()
  })

  it('«Срочный отчёт», «Подробнее», «Графики» — от подписчика; повтор в течение минуты — отказ', async () => {
    await setupActive()
    await seedMetrics()
    await hook(press(ADMIN_TG, 'rep:now'))
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('срочный отчёт'))).toBe(true)
    await hook(press(ADMIN_TG, 'rep:now'))
    const refusal = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.body
    expect(refusal?.text).toContain('уже запрашивали меньше минуты назад')
    expect(refusal?.show_alert).toBe(false)
    calls.splice(0)
    await hook(press(ADMIN_TG, `rep:more:${Math.floor(Date.now() / 60_000)}`))
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('подробный отчёт'))).toBe(true)
    calls.splice(0)
    await hook(press(ADMIN_TG, 'rep:charts'))
    const album = calls.find((c) => c.method === 'sendMediaGroup')
    expect(album?.multipart).toBe(true)
    expect(album!.bytes).toBeGreaterThan(5000)
  })

  it('незнакомец и неподтвердивший пароль кнопками не пользуются', async () => {
    await setupActive()
    calls.splice(0)
    await hook(press(4242, 'rep:now'))
    const ans = calls.find((c) => c.method === 'answerCallbackQuery')
    expect(ans?.body).toMatchObject({ show_alert: true })
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false)
  })

  it('/report и /charts в личке; в группе — только оператор и только в группе-канале консоли', async () => {
    await setupActive()
    await seedMetrics()
    await hook(pm(ADMIN_TG, '/report'))
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('срочный отчёт'))).toBe(true)
    calls.splice(0)
    const group = (from: number, text: string) => hook({ message: { message_id: 2, chat: { id: -100777, type: 'supergroup' }, from: { id: from, is_bot: false }, text } })
    // Незнакомец — тишина.
    await group(9999, '/charts')
    expect(calls.some((c) => c.method === 'sendMediaGroup' || c.method === 'sendMessage')).toBe(false)
    // Команда другому боту — не нам.
    await group(ADMIN_TG, '/charts@other_bot')
    expect(calls.length).toBe(0)
    // Группа не подключена каналом — отказ, без отчёта.
    await group(ADMIN_TG, '/charts@ops_test_bot')
    expect(calls.some((c) => c.method === 'sendMediaGroup')).toBe(false)
    expect(String(calls.find((c) => c.method === 'sendMessage')?.body.text)).toContain('не подключена каналом')
    // Подключили каналом консоли с тем же ботом — отчёт уходит и пишется в журнал.
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'дежурные', configJson: JSON.stringify({ chatId: '-100777' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() })
    calls.splice(0)
    await group(ADMIN_TG, '/charts@Ops_Test_Bot')
    expect(calls.some((c) => c.method === 'sendMediaGroup' && c.bytes > 5000)).toBe(true)
    const log = await getDb().query.activity.findMany()
    expect(log.some((a) => a.message.includes('в группу -100777') && a.actor === 'anna@ops.test')).toBe(true)
  })

  it('наблюдатель получает отчёт в личке, но не может разослать его в группу', async () => {
    await setupActive('viewer')
    await getDb()
      .insert(channels)
      .values({ kind: 'telegram', name: 'дежурные', configJson: JSON.stringify({ chatId: '-100777' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() })
    await hook(press(ADMIN_TG, 'rep:now'))
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('срочный отчёт'))).toBe(true)
    calls.splice(0)
    await hook(press(ADMIN_TG, 'rep:charts', -100777))
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({ show_alert: true, text: expect.stringContaining('оператор') })
    expect(calls.some((c) => c.method === 'sendMediaGroup' || c.method === 'sendPhoto')).toBe(false)
  })

  it('кривой rep:more и чужие callback_data — без работы; сбой работы возвращает слот', async () => {
    await setupActive()
    for (const data of ['rep:more:', 'rep:more:-5', 'rep:more:1e9', 'al:ack:x', 'al:ack:99999999999999']) {
      calls.splice(0)
      await hook(press(ADMIN_TG, data))
      expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
    }
    // Telegram отверг отчёт — слот возвращён, повтор сразу проходит.
    spy.mockImplementationOnce(async () => ({ status: 400, ok: false, text: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), latencyMs: 1 }))
    await hook(press(ADMIN_TG, 'rep:now'))
    calls.splice(0)
    await hook(press(ADMIN_TG, 'rep:now'))
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('срочный отчёт'))).toBe(true)
  })

  it('карточка алерта: кнопки «Беру в работу» / «Тишина» и ссылка; нажатие оператора — ack; наблюдателю — отказ', async () => {
    await setupActive('operator')
    await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'x', breached: true, title: 'CPU', object: 'prod', value: '97%' })
    const card = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))!
    const markup = JSON.stringify(card.body.reply_markup)
    expect(markup).toMatch(/al:ack:\d+/)
    expect(markup).toContain('🔗 В консоли')
    expect(markup).toMatch(/mo:a:\d+/)
    const alertId = Number(/al:ack:(\d+)/.exec(markup)![1])
    await hook(press(ADMIN_TG, `al:ack:${alertId}`))
    const row = await getDb().query.alerts.findFirst({ where: eq(alerts.id, alertId) })
    expect(row?.acknowledgedBy).toBe('anna@ops.test')
    // Повторное нажатие — не перезаписывает и не шумит в чате.
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:ack:${alertId}`))
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
    expect(calls[0]!.body.text).toBe('Вы уже взяли этот алерт.')
    // Тишина с кнопки не укорачивает уже выставленную в консоли тишину на сутки.
    const day = new Date(Date.now() + 86_400_000)
    await getDb().update(alerts).set({ silencedUntil: day }).where(eq(alerts.id, alertId))
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:mute:${alertId}`))
    expect(calls[0]!.body.text).toMatch(/^Тишина уже стоит — до /)
    expect((await getDb().query.alerts.findFirst({ where: eq(alerts.id, alertId) }))?.silencedUntil?.getTime()).toBe(day.getTime())
    await getDb().update(users).set({ role: 'viewer' }).where(eq(users.email, 'anna@ops.test'))
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:mute:${alertId}`))
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.text).toContain('роль оператора')
  })
})

describe('ревью: повторы, карточка, графики', () => {
  it('«Тишина 1 ч» дважды подряд — один эффект; карточка показывает тишину и «в работе», нажатые кнопки уходят', async () => {
    await setupActive('operator')
    await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'y', breached: true, title: 'RAM', object: 'prod', value: '95%' })
    const card = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_TG))!
    const alertId = Number(/al:mute:(\d+)/.exec(JSON.stringify(card.body.reply_markup))![1])
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:mute:${alertId}`))
    const edit = calls.find((c) => c.method === 'editMessageText')
    expect(edit?.body.text).toContain('🔕 Тишина до')
    expect(JSON.stringify(edit?.body.reply_markup)).not.toContain('al:mute')
    expect(JSON.stringify(edit?.body.reply_markup)).toContain('al:ack')
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:mute:${alertId}`))
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
    calls.splice(0)
    await hook(press(ADMIN_TG, `al:ack:${alertId}`))
    const edit2 = calls.find((c) => c.method === 'editMessageText')
    expect(edit2?.body.text).toContain('✋ В работе: anna@ops.test')
    expect(JSON.stringify(edit2?.body.reply_markup ?? {})).not.toContain('al:')
    const log = await getDb().query.activity.findMany()
    expect(log.filter((a) => a.message.startsWith('Тишина 60 мин')).length).toBe(1)
  })

  it('графики: пустые не отправляются; один график — фото; нет метрик — понятное сообщение', async () => {
    await setupActive()
    await hook(pm(ADMIN_TG, '/charts'))
    expect(calls.some((c) => c.method === 'sendMediaGroup' || c.method === 'sendPhoto')).toBe(false)
    expect(String(calls.find((c) => c.method === 'sendMessage')?.body.text)).toContain('Графиков нет')
    await seedMetrics(['cpu_pct'])
    resetSnapshotCacheForTests()
    await getDb().delete(loginAttempts)
    calls.splice(0)
    await hook(pm(ADMIN_TG, '/charts'))
    expect(calls.map((c) => c.method)).toContain('sendPhoto')
  })

  it('кнопки под алертом — только для канала с числовым chat id (у «@канала» нажатие не опознать)', async () => {
    await setupActive()
    await getDb()
      .insert(channels)
      .values([
        { kind: 'telegram', name: 'по имени', configJson: JSON.stringify({ chatId: '@ops_alerts' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() },
        { kind: 'telegram', name: 'по id', configJson: JSON.stringify({ chatId: '-100900' }), secretEnc: encryptJson({ botToken: TOKEN }), createdAt: new Date() },
      ])
    calls.splice(0)
    await observe({ rule: { id: 1, forSamples: 1, severity: 'critical', repeatMin: 0 }, fingerprint: 'z', breached: true, title: 'Disk', object: 'prod', value: '99%' })
    const byName = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '@ops_alerts')!
    const byId = calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === '-100900')!
    expect(JSON.stringify(byName.body.reply_markup ?? {})).not.toContain('al:ack')
    expect(JSON.stringify(byId.body.reply_markup)).toContain('al:ack')
  })
})
