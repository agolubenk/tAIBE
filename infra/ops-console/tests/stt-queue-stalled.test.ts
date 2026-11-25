/**
 * Очередь распознавания: тревога «ждут, а в работе ни одной 15 минут» вместо «больше 5 ждут 30 минут» (load-design В8,
 * шаг 1; решение владельца d-load-steps-1-3, 22.10). Длинная, но разбирающаяся очередь — не тревога. Сквозь приём
 * отчёта агента с бизнес-метриками, на настоящей БД.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { api, freshApp, login, report, signedAgentRequest } from './helpers'
import { getDb } from '../server/db/client'
import { activity, alertRules, alerts, ruleStreaks } from '../server/db/schema'
import { ensureBuiltinRules } from '../server/alerts/builtin'
import { writeMarker } from '../server/settings/store'

const NEW_NAME = 'STT: очередь распознавания стоит'
const OLD_NAME = 'STT: очередь распознавания не разбирается'

let app: Awaited<ReturnType<typeof freshApp>>
let owner: ReturnType<typeof api>
let secret = ''
let at = 1_900_000_000

const ctr = (name: string) => ({ name, image: `${name}:1`, state: 'running', health: 'healthy', status: 'Up', restartCount: 0, composeService: name, restartPolicy: 'unless-stopped' })
const healthy = [ctr('backend')]
/** Один замер бизнес-метрик (раз в 5 минут), повторённый в двух отчётах агента. */
const measure = async (business: Record<string, number>) => {
  at += 300
  for (let i = 0; i < 2; i += 1) await app.request('/api/agent/report', signedAgentRequest('prod', secret, report(healthy, { business, businessAt: at, businessFailed: [] })))
}
const firing = async () => ((await owner.get('/alerts?status=firing')).json.alerts as Array<{ title: string; object: string; value: string; hint: string }>)
const sttRule = (name: string) => getDb().query.alertRules.findFirst({ where: and(eq(alertRules.builtin, true), eq(alertRules.name, name)) })

beforeAll(async () => {
  app = await freshApp()
  owner = api(app, await login(app))
  secret = (await owner.post('/admin/agents', { id: 'prod', name: 'Contabo · prod' })).json.secret
  await ensureBuiltinRules()
})

describe('очередь распознавания стоит', () => {
  it('новая консоль: правило «ждут, а в работе ни одной», 3 замера (15 минут); старого «больше 5» нет', async () => {
    expect(await sttRule(NEW_NAME)).toMatchObject({ metric: 'biz_stt_queue_stalled', op: 'gt', threshold: 0, forSamples: 3, severity: 'warning' })
    expect(await sttRule(OLD_NAME)).toBeUndefined()
  })

  it('длинная очередь, которая разбирается, — тихо; стоит 3 замера подряд — тревога «ждут, а в работе ни одной»', async () => {
    // Агент считает 0, пока active > 0: сотни ждущих при работающем обработчике — не тревога.
    for (let i = 0; i < 5; i += 1) await measure({ stt_queue_stalled: 0, stt_queue_waiting: 400 })
    expect((await firing()).find((a) => a.title === NEW_NAME)).toBeUndefined()
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    expect((await firing()).find((a) => a.title === NEW_NAME)).toBeUndefined()
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    const alert = (await firing()).find((a) => a.title === NEW_NAME)
    expect(alert?.object).toBe('STT · Contabo · prod')
    expect(alert?.hint).toContain('обработчик очереди meeting-stt их не берёт')
    // Обработчик снова берёт задачи — закрывается.
    for (let i = 0; i < 3; i += 1) await measure({ stt_queue_stalled: 0, stt_queue_waiting: 2 })
    expect((await firing()).find((a) => a.title === NEW_NAME)).toBeUndefined()
  })

  it('работающая консоль: «больше 5 за 30 минут» → «ждут, а в работе ни одной» один раз; правленое владельцем не трогается', async () => {
    const db = getDb()
    const row = (await sttRule(NEW_NAME))!
    const marker = 'builtin_upgrade_stt_queue_stalled'
    // Консоль до 22.10: строка v3 со старым правилом, отметки нет.
    await db.update(alertRules).set({ name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 5, forSamples: 7 }).where(eq(alertRules.id, row.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await db.query.alertRules.findFirst({ where: eq(alertRules.id, row.id) })).toMatchObject({
      name: NEW_NAME, metric: 'biz_stt_queue_stalled', threshold: 0, forSamples: 3,
    })
    // Владелец поменял длительность старого правила — его строку не трогаем.
    await db.update(alertRules).set({ name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 5, forSamples: 10 }).where(eq(alertRules.id, row.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await db.query.alertRules.findFirst({ where: eq(alertRules.id, row.id) })).toMatchObject({
      name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 5, forSamples: 10,
    })
    await db.update(alertRules).set({ name: NEW_NAME, metric: 'biz_stt_queue_stalled', threshold: 0, forSamples: 3 }).where(eq(alertRules.id, row.id))
  })

  it('правка старой строки при горящем алерте и набранном стрике: алерт закрыт, счётчики сброшены, новое условие с нуля', async () => {
    const db = getDb()
    const row = (await sttRule(NEW_NAME))!
    const marker = 'builtin_upgrade_stt_queue_stalled'
    await db.update(alertRules).set({ name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 5, forSamples: 7 }).where(eq(alertRules.id, row.id))
    // Ночной замер: 50 ждущих при работающем обработчике — старое правило горит.
    for (let i = 0; i < 7; i += 1) await measure({ stt_queue_waiting: 50, stt_queue_stalled: 0 })
    const old = await db.query.alerts.findFirst({ where: and(eq(alerts.ruleId, row.id), eq(alerts.status, 'firing')) })
    expect(old).toBeDefined()
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    expect(await db.query.alerts.findFirst({ where: eq(alerts.id, old!.id) })).toMatchObject({
      status: 'resolved',
      resolution: 'правило заменено новым условием — прежнее больше не проверяется',
    })
    expect(await db.query.ruleStreaks.findMany({ where: like(ruleStreaks.fingerprint, `%rule:${row.id}:%`) })).toEqual([])
    // Новое условие считает с нуля: два замера «стоит» — ещё тихо.
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    expect((await firing()).find((a) => a.title === NEW_NAME)).toBeUndefined()
    for (let i = 0; i < 3; i += 1) await measure({ stt_queue_stalled: 0, stt_queue_waiting: 0 })
  })

  it('строку, которую владелец менял, правка не трогает — и пишет в ленту, что старое правило осталось', async () => {
    const db = getDb()
    const row = (await sttRule(NEW_NAME))!
    const marker = 'builtin_upgrade_stt_queue_stalled'
    await db.delete(activity)
    await db.update(alertRules).set({ name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 3, forSamples: 7 }).where(eq(alertRules.id, row.id))
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    const notes = (await db.query.activity.findMany()).map((a) => a.message)
    expect(notes.some((m) => m.startsWith('Правило «STT: очередь распознавания не разбирается» не обновлено: вы его меняли.'))).toBe(true)
    await db.update(alertRules).set({ name: NEW_NAME, metric: 'biz_stt_queue_stalled', threshold: 0, forSamples: 3 }).where(eq(alertRules.id, row.id))
  })

  it('стрик старого условия без алерта не переносится в новое: первый замер «стоит» после правки — не тревога', async () => {
    const db = getDb()
    const row = (await sttRule(NEW_NAME))!
    const marker = 'builtin_upgrade_stt_queue_stalled'
    await db.delete(activity)
    await db.update(alertRules).set({ name: OLD_NAME, metric: 'biz_stt_queue_waiting', threshold: 5, forSamples: 7 }).where(eq(alertRules.id, row.id))
    // Пять замеров над порогом — стрик 5 из 7, алерта ещё нет.
    for (let i = 0; i < 5; i += 1) await measure({ stt_queue_waiting: 50, stt_queue_stalled: 3 })
    expect(await db.query.alerts.findFirst({ where: and(eq(alerts.ruleId, row.id), eq(alerts.status, 'firing')) })).toBeUndefined()
    await writeMarker(marker, 0)
    await ensureBuiltinRules()
    // Строку правка обновила — заметки «вы его меняли» нет.
    expect((await db.query.activity.findMany()).some((a) => a.message.includes('вы его меняли'))).toBe(false)
    await measure({ stt_queue_stalled: 3, stt_queue_waiting: 3 })
    expect((await firing()).find((a) => a.title === NEW_NAME)).toBeUndefined()
    for (let i = 0; i < 3; i += 1) await measure({ stt_queue_stalled: 0, stt_queue_waiting: 0 })
  })
})
