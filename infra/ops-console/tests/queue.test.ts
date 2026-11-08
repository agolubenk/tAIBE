// Очередь владельца: права по полям (ответ владельца агенту не менять), правило planEnd, версии, ETag,
// страница /queue (скрипты — файлами с хэшем, CSP без nonce) и подмена базы, мёрж по закреплённому SHA с [skip ci]
// и запретом во время деплоя.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { api, freshApp, login } from './helpers'
import { OPEN_RULE_JS } from '../server/queue/open-rule'
import { SHIM_JS } from '../server/queue/page-scripts'
import { createToken, revokeToken } from '../server/queue/auth'
import { mergePlan, mergeRequestBody, setGithubTransportForTests, type GithubResponse } from '../server/queue/github'
import { deleteDoc, importDoc, writeDoc } from '../server/queue/store'
import { getGithubSettings, writeSetting } from '../server/settings/store'
import { encryptSecret } from '../server/lib/crypto'

type App = Awaited<ReturnType<typeof freshApp>>
let app: App
let cookie: string
let agent: string
let owner: string
let reader: string

function bearer(token: string) {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/oq/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, headers: res.headers }
  }
  return {
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    put: (p: string, b: unknown) => call('PUT', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
  }
}

beforeAll(async () => {
  app = await freshApp()
  cookie = await login(app)
  agent = (await createToken('test-agent', ['read', 'agent'])).token
  owner = (await createToken('queue-bot', ['owner'])).token
  reader = (await createToken('reader', ['read'])).token
})

afterEach(() => setGithubTransportForTests(null))

const decision = { kind: 'decision', title: 'Решение', body: 'Текст', options: [{ id: 'yes', label: 'Да', hint: 'рекомендую' }], source: 'test' }

describe('документы и права', () => {
  it('агент добавляет пункт, список отдаёт его, повторный опрос с ETag — 304', async () => {
    const a = bearer(agent)
    const put = await a.put('/db/items/d-test', { data: decision })
    expect(put.status).toBe(200)
    expect(put.json.version).toBe(1)
    const list = await a.get('/db/items')
    expect(list.json.docs.map((d: any) => d.id)).toContain('d-test')
    const again = await a.get('/db/items', { 'If-None-Match': list.headers.get('etag')! })
    expect(again.status).toBe(304)
  })

  it('агент пишет свой статус, но не ответ владельца и не set по checks', async () => {
    const a = bearer(agent)
    expect((await a.patch('/db/checks/d-test', { data: { agentStatus: 'doing', agentNote: 'взял' } })).status).toBe(200)
    expect((await a.patch('/db/checks/d-test', { data: { done: true } })).status).toBe(403)
    expect((await a.put('/db/checks/d-test', { data: { agentStatus: 'done' } })).status).toBe(403)
  })

  it('владелец (сессия консоли) отвечает; без CSRF-заголовка — отказ', async () => {
    const o = api(app, cookie)
    const res = await o.put('/oq/v1/db/checks/d-test', { data: { done: true, choice: 'yes', note: '', at: '2026-10-18T10:00:00.000Z', agentStatus: 'doing', agentNote: 'взял' } })
    expect(res.status).toBe(200)
    const noCsrf = await app.request('/api/oq/v1/db/checks/d-test', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { done: false } }) })
    expect(noCsrf.status).toBe(403)
  })

  it('устаревшая версия — 409, неверный документ — 422, только чтение — 403, отозванный токен — 401', async () => {
    const a = bearer(agent)
    expect((await a.patch('/db/items/d-test', { data: { title: 'Новое' }, ifVersion: 1 })).status).toBe(200)
    expect((await a.patch('/db/items/d-test', { data: { title: 'Ещё' }, ifVersion: 1 })).status).toBe(409)
    expect((await a.put('/db/items/d-bad', { data: { kind: 'decision', title: 'Без вариантов' } })).status).toBe(422)
    expect((await a.put('/db/items/c-bad', { data: { kind: 'check', title: 'x', links: [{ href: 'http://evil.example' }] } })).status).toBe(422)
    expect((await bearer(reader).put('/db/items/d-r', { data: decision })).status).toBe(403)
    // Пустая правка checks токеном «только чтение» — тоже отказ: не создаёт документ и не поднимает версию.
    expect((await bearer(reader).patch('/db/checks/d-empty', { data: {} })).status).toBe(403)
    expect((await bearer(reader).get('/db/checks/d-empty')).status).toBe(404)
    expect((await bearer(reader).get('/db/items')).status).toBe(200)
    const noScope = await createToken('agent-only', ['agent'])
    expect((await bearer(noScope.token).get('/db/items')).status).toBe(200)
    expect((await app.request('/api/oq/v1/db/items/d-test', { method: 'DELETE', headers: { Authorization: `Bearer ${agent}` } })).status).toBe(403)
    const t = await createToken('temp', ['agent'])
    await revokeToken(t.id)
    expect((await bearer(t.token).get('/db/items')).status).toBe(401)
  })

  it('planEnd агент не переписывает без basePlanEnd', async () => {
    const a = bearer(agent)
    expect((await a.put('/db/work/w-t', { data: { title: 'Задача', track: 'ops', planEnd: '2026-10-20' } })).status).toBe(200)
    expect((await a.patch('/db/work/w-t', { data: { planEnd: '2026-10-25' } })).status).toBe(409)
    expect((await a.patch('/db/work/w-t', { data: { planEnd: '2026-10-25', basePlanEnd: '2026-10-20', note: 'сдвиг: ждали ревью' } })).status).toBe(200)
  })

  it('история пункта — журнал изменений', async () => {
    const h = await bearer(agent).get('/history/items/d-test')
    expect(h.json.events.length).toBeGreaterThanOrEqual(2)
    expect(h.json.events[0].actor).toBe('token:test-agent')
  })

  it('импорт выгрузки артефакта не перезаписывает существующее', async () => {
    expect(await importDoc('checks', 'd-imp', { done: true, choice: 'do', note: '', at: '2026-10-11T12:24:10.688Z' }, 'import:artifact')).toBe('added')
    expect(await importDoc('checks', 'd-imp', { done: false }, 'import:artifact')).toBe('kept')
    expect(await importDoc('items', 'd-x', { kind: 'decision', title: 'нет вариантов' }, 'import:artifact')).toBe('invalid')
  })
})

const inbox = (over: Record<string, unknown> = {}) => ({
  kind: 'inbox',
  title: 'Не грузится запись встречи',
  source: 'telegram',
  inbox: { type: 'bug', urgency: 'queue', severity: 'medium', text: 'Не грузится запись встречи', origin: 'сам', originKind: 'self', forwarded: false, receivedAt: '2026-10-21T09:00:00.000Z', ...over },
})

describe('входящие из Telegram (kind: inbox)', () => {
  it('бот (токен владельца) кладёт входящее; агент видит его в списке и пишет свой статус', async () => {
    const put = await bearer(owner).put('/db/items/i-20261021-0900-ab12', { data: inbox() })
    expect(put.status).toBe(200)
    const list = await bearer(agent).get('/db/items')
    expect(list.json.docs.find((d: { id: string }) => d.id === 'i-20261021-0900-ab12')?.data.inbox.type).toBe('bug')
    expect((await bearer(agent).patch('/db/checks/i-20261021-0900-ab12', { data: { agentStatus: 'taken', agentNote: 'беру', agentBy: 's1' } })).status).toBe(200)
  })

  it('агент не создаёт и не меняет входящее: выдать свой текст за слова владельца нельзя', async () => {
    expect((await bearer(agent).put('/db/items/i-20261021-0901-ffff', { data: inbox({ origin: 'сам', urgency: 'now' }) })).status).toBe(403)
    expect((await bearer(agent).patch('/db/items/i-20261021-0900-ab12', { data: { title: 'Подменённый заголовок' } })).status).toBe(403)
    // и не «разжалует» его в обычный пункт: схема пропустит check без inbox, отказ — по правам
    expect((await bearer(agent).patch('/db/items/i-20261021-0900-ab12', { data: { kind: 'check', inbox: null } })).status).toBe(403)
  })

  it('захват: «взял» поверх чужого «взял / в работе» — 409; та же сессия и «сделано» — можно', async () => {
    await bearer(owner).put('/db/items/i-claim', { data: inbox() })
    const st = (data: Record<string, unknown>) => bearer(agent).patch('/db/checks/i-claim', { data })
    expect((await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    const busy = await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-44' })
    expect(busy.status).toBe(409)
    expect(busy.json.error).toContain('hr-helper-v2-70')
    const anon = await st({ agentStatus: 'doing' }) // без agentBy не понять, та же ли это сессия
    expect(anon.status).toBe(409)
    expect(anon.json.error).toContain('передайте session')
    expect((await st({ agentStatus: 'doing', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    expect((await st({ agentStatus: 'done', agentNote: 'карточка заведена', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    expect((await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-44' })).status).toBe(200) // после «сделано» — свободен
  })

  it('чужая сессия не снимает захват через planned / blocked / done / заметку (GLM-линза безопасности #281)', async () => {
    await bearer(owner).put('/db/items/i-claim-2', { data: inbox() })
    const st = (data: Record<string, unknown>) => bearer(agent).patch('/db/checks/i-claim-2', { data })
    expect((await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    for (const agentStatus of ['planned', 'blocked', 'done']) {
      expect((await st({ agentStatus, agentBy: 'hr-helper-v2-44' })).status, agentStatus).toBe(409)
    }
    expect((await st({ agentNote: 'чужая заметка', agentBy: 'hr-helper-v2-44' })).status).toBe(409)
    // сама сессия переводит пункт куда угодно — захват держится, пока не «сделано»
    expect((await st({ agentStatus: 'blocked', agentNote: 'жду ответа владельца', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    expect((await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-44' })).status).toBe(409)
  })

  it('входящее без session не берётся (422, старый MCP), а обычный пункт старый MCP ведёт как раньше', async () => {
    await bearer(owner).put('/db/items/i-nosession', { data: inbox() })
    const noSession = await bearer(agent).patch('/db/checks/i-nosession', { data: { agentStatus: 'taken', agentNote: 'беру' } })
    expect(noSession.status).toBe(422)
    expect(noSession.json.error).toContain('session')
    // обычный пункт: захвата нет — две сессии и вызов без session пишут свой статус по очереди
    await bearer(agent).put('/db/items/c-common', { data: { kind: 'check', title: 'Проверка', source: 'test' } })
    const c = (data: Record<string, unknown>) => bearer(agent).patch('/db/checks/c-common', { data })
    expect((await c({ agentStatus: 'taken', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    expect((await c({ agentStatus: 'doing', agentBy: 'hr-helper-v2-44' })).status).toBe(200)
    expect((await c({ agentStatus: 'done', agentNote: 'проверено' })).status).toBe(200)
    // и у пункта без документа items (как d-test выше) — тоже без захвата
    expect((await bearer(agent).patch('/db/checks/d-noitem', { data: { agentStatus: 'taken' } })).status).toBe(200)
  })

  it('захват снимается через 12 ч без записей сессии; время записи — серверное, присланное агентом не принимается', async () => {
    await bearer(owner).put('/db/items/i-stale', { data: inbox() })
    const before = Date.now()
    const took = await bearer(agent).patch('/db/checks/i-stale', { data: { agentStatus: 'taken', agentBy: 'hr-helper-v2-70', agentAt: '2000-01-01T00:00:00.000Z' } })
    expect(took.status).toBe(200)
    expect(Date.parse(took.json.data.agentAt)).toBeGreaterThanOrEqual(before - 1000)
    expect((await bearer(agent).patch('/db/checks/i-stale', { data: { agentStatus: 'taken', agentBy: 'hr-helper-v2-44' } })).status).toBe(409)
    // 13 ч без записей (время ставит владелец — агенту сервер своё agentAt не даёт подделать)
    const old = new Date(Date.now() - 13 * 3600_000).toISOString()
    expect((await bearer(owner).patch('/db/checks/i-stale', { data: { agentAt: old } })).status).toBe(200)
    expect((await bearer(agent).patch('/db/checks/i-stale', { data: { agentStatus: 'taken', agentBy: 'hr-helper-v2-44' } })).status).toBe(200)
  })

  it('уход без наследника: держатель отпускает захват — снимается имя, статус и заметка остаются; чужая сессия отпустить не может', async () => {
    await bearer(owner).put('/db/items/i-release', { data: inbox() })
    const st = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => bearer(agent).patch('/db/checks/i-release', { data, ...extra })
    expect((await st({ agentStatus: 'doing', agentNote: 'начал', agentBy: 'r.ab12' })).status).toBe(200)
    expect((await st({ agentBy: 'r.zz99' }, { release: true })).status).toBe(409)
    const rel = await st({ agentNote: 'ухожу без наследника', agentBy: 'r.ab12' }, { release: true })
    expect(rel.status).toBe(200)
    expect(rel.json.data.agentBy).toBeUndefined()
    expect(rel.json.data.agentStatus).toBe('doing')
    expect(rel.json.data.agentNote).toBe('ухожу без наследника')
    expect((await st({ agentStatus: 'taken', agentBy: 'r.zz99' })).status).toBe(200)
    // Чужая сессия не стирает подпись и у пункта, который уже не держится (сделано).
    expect((await st({ agentStatus: 'done', agentBy: 'r.zz99' })).status).toBe(200)
    expect((await st({ agentBy: 'r.other' }, { release: true })).status).toBe(409)
  })

  it('release — только у входящих: у обычного пункта захвата нет, подпись agentBy не стирается (линза безопасности HR #521)', async () => {
    await bearer(owner).put('/db/items/d-release', { data: decision })
    const st = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => bearer(agent).patch('/db/checks/d-release', { data, ...extra })
    expect((await st({ agentStatus: 'doing', agentNote: 'начал', agentBy: 'r.ab12' })).status).toBe(200)
    const rel = await st({ agentBy: 'r.zz99' }, { release: true })
    expect(rel.status).toBe(422)
    expect(rel.json.error).toContain('только у входящих')
    expect((await bearer(owner).patch('/db/checks/d-release', { data: {}, release: true })).status).toBe(422)
    expect((await bearer(agent).get('/db/checks/d-release')).json.data.agentBy).toBe('r.ab12')
    // Ответ без пункта (опечатка в id, пункт удалён) — 404, а не «только у входящих».
    expect((await bearer(agent).patch('/db/checks/nope-release', { data: { agentBy: 'r.ab12' }, release: true })).status).toBe(404)
  })

  it('линия длиннее 120 символов (поколение 30): захват и перехват наследником работают', async () => {
    const line = 'r' + Array.from({ length: 30 }, (_, i) => '.' + String(i).padStart(4, 'a')).join('')
    expect(line.length).toBeGreaterThan(120)
    await bearer(owner).put('/db/items/i-long-line', { data: inbox() })
    const st = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => bearer(agent).patch('/db/checks/i-long-line', { data, ...extra })
    expect((await st({ agentStatus: 'doing', agentBy: line })).status).toBe(200)
    expect((await st({ agentStatus: 'doing', agentBy: `${line}.zz99` }, { takeover: line })).status).toBe(200)
    expect((await bearer(agent).get('/db/checks/i-long-line')).json.data.agentBy).toBe(`${line}.zz99`)
  })

  it('передача линии: наследник по линии берёт пункт сразу, назвав держателя; не наследник — нет, как бы ни назвался', async () => {
    await bearer(owner).put('/db/items/i-takeover', { data: inbox() })
    const st = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => bearer(agent).patch('/db/checks/i-takeover', { data, ...extra })
    expect((await st({ agentStatus: 'doing', agentBy: 'r.ab12' })).status).toBe(200)
    // Наследнику без takeover — подсказка; не наследнику — без подсказки, и takeover ему не помогает.
    expect(String((await st({ agentStatus: 'taken', agentBy: 'r.ab12.cd34' })).json.error)).toMatch(/takeover: «r\.ab12»/)
    const stranger = await st({ agentStatus: 'taken', agentBy: 'r.zz99' }, { takeover: 'r.ab12' })
    expect(stranger.status).toBe(409)
    expect(String(stranger.json.error)).not.toMatch(/takeover/)
    // Любая длина сегмента (PID в spawn_session.sh), но граница сегмента — точка.
    for (const by of ['r.ab12x.cd34', 'r.ab1.cd34', 'hr-helper-v2-70', 'r.AB12.cd34']) expect((await st({ agentStatus: 'taken', agentBy: by }, { takeover: 'r.ab12' })).status, by).toBe(409)
    expect((await st({ agentStatus: 'taken', agentBy: 'r.ab12.cd34' }, { takeover: 'r.wrong' })).status).toBe(409)
    const took = await st({ agentStatus: 'taken', agentBy: 'r.ab12.cd34' }, { takeover: 'r.ab12' })
    expect((await bearer(owner).put('/db/items/i-pid', { data: inbox() })).status).toBe(200)
    expect((await bearer(agent).patch('/db/checks/i-pid', { data: { agentStatus: 'doing', agentBy: 'r.12345' } })).status).toBe(200)
    expect((await bearer(agent).patch('/db/checks/i-pid', { data: { agentStatus: 'taken', agentBy: 'r.12345.ab12' }, takeover: 'r.12345' })).status).toBe(200)
    expect(took.status).toBe(200)
    expect(took.json.data.agentBy).toBe('r.ab12.cd34')
    // Теперь держит наследник: предок — уже чужая сессия, и сам его не перехватит (линия не продолжает наследника).
    expect((await st({ agentStatus: 'doing', agentBy: 'r.ab12' }, { takeover: 'r.ab12.cd34' })).status).toBe(409)
  })

  it('держатель с именем вместо линии не наследуется: 12 ч или его собственный отпуск; захват без времени записи — не захват', async () => {
    await bearer(owner).put('/db/items/i-legacy', { data: inbox() })
    const st = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => bearer(agent).patch('/db/checks/i-legacy', { data, ...extra })
    expect((await st({ agentStatus: 'doing', agentBy: 'hr-helper-v2-70' })).status).toBe(200)
    expect((await st({ agentStatus: 'taken', agentBy: 'hr-helper-v2-70.ab12' }, { takeover: 'hr-helper-v2-70' })).status).toBe(409)
    // Ответ из импорта выгрузки — без agentAt: такой пункт больше не держится вечно.
    await bearer(owner).put('/db/items/i-imported', { data: inbox() })
    expect(await importDoc('checks', 'i-imported', { agentStatus: 'doing', agentBy: 'hr-helper-v2-70' }, 'import:test')).toBe('added')
    expect((await bearer(agent).patch('/db/checks/i-imported', { data: { agentStatus: 'taken', agentBy: 'r.zz99' } })).status).toBe(200)
    expect((await st({ agentStatus: 'doing', agentBy: '   ' })).status).toBe(422)
    // Сохранённое пустое имя (старый MCP) не блокирует ответ владельца: проверяется присланное.
    await bearer(owner).put('/db/items/i-blank', { data: inbox() })
    expect(await importDoc('checks', 'i-blank', { agentStatus: 'doing', agentBy: ' ' }, 'import:test')).toBe('added')
    expect((await bearer(owner).patch('/db/checks/i-blank', { data: { done: true, at: new Date().toISOString() } })).status).toBe(200)
  })

  it('недопустимые значения — 422: неизвестный тип, важность у идеи, длинный текст, пустой текст, лишнее поле', async () => {
    expect((await bearer(owner).put('/db/items/i-bad-1', { data: inbox({ type: 'spam' }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-2', { data: inbox({ type: 'idea' }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-3', { data: inbox({ text: 'x'.repeat(8001) }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-4', { data: inbox({ text: '' }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-5', { data: inbox({ chatId: 42 }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-7', { data: inbox({ originKind: 'owner' }) })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/i-bad-8', { data: inbox({ forwarded: undefined }) })).status).toBe(422)
  })

  it('inbox — только у kind: inbox, и kind: inbox — только с полем inbox', async () => {
    const { inbox: fields } = inbox()
    expect((await bearer(owner).put('/db/items/i-bad-6', { data: { kind: 'inbox', title: 'Без полей' } })).status).toBe(422)
    expect((await bearer(owner).put('/db/items/c-bad-inbox', { data: { kind: 'check', title: 'Проверка', inbox: fields } })).status).toBe(422)
  })

  it('контракт с ботом: пункт, который собирает бот очереди, схема принимает — для всех типов', async () => {
    // @ts-expect-error — модуль бота на чистом JS (infra/owner-queue-bot), типов у него нет
    const { draftFrom, itemOf } = await import('../../owner-queue-bot/inbox.mjs')
    const msgs = [
      { text: '🔴 Распознавание встреч падает', forward_origin: { type: 'user', sender_user: { id: 1, is_bot: true, username: 'hrmhrhelper_space_allerting_bot' } } },
      { text: 'На проде 502 у всех' },
      { text: 'Идея: экспорт в Excel' },
      { text: 'Добавить поле «отдел»' },
      { photo: [{ file_id: 'x' }] },
      { text: 'x'.repeat(9000) },
    ]
    for (const m of msgs) {
      const d = draftFrom(m, { alertBots: ['hrmhrhelper_space_allerting_bot'] })
      const res = await bearer(owner).put(`/db/items/${d.id}`, { data: itemOf(d) })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
    }
  })

  it('контракт со страницей: пункт формы «Поставить задачу» схема принимает — для всех типов', async () => {
    // Функции формы живут в page.html (блок oq-pure) — исполняем его в отдельном контексте vm, как queue-page.test.ts.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { createContext, runInContext } = await import('node:vm')
    const page = readFileSync(join(__dirname, '../server/queue/page.html'), 'utf8')
    const ctx: Record<string, unknown> = createContext({})
    runInContext(page.slice(page.indexOf('/* oq-pure:start'), page.indexOf('/* oq-pure:end */')), ctx)
    const itemOf = ctx.inboxItemOf as (d: Record<string, unknown>, at: string) => Record<string, unknown>
    const drafts = [
      { text: 'На проде 502 у всех', type: 'bug', urgency: 'now', severity: 'high' },
      { text: 'Идея: экспорт', type: 'idea', urgency: 'queue' },
      { text: 'Добавить поле', type: 'task', urgency: 'queue' },
      { text: '🔴 Алерт горит', type: 'alert', urgency: 'now', severity: 'critical' },
      { text: 'x'.repeat(9000), type: 'task', urgency: 'queue' },
      // «средняя» и «низкая» — те же значения, что у бота и схемы (доделки формы #290).
      { text: 'Не грузится запись встречи', type: 'bug', urgency: 'queue', severity: 'medium' },
      { text: 'Опечатка в подписи кнопки', type: 'bug', urgency: 'queue', severity: 'low' },
    ]
    for (const [i, d] of drafts.entries()) {
      const res = await bearer(owner).put(`/db/items/i-20261021-120000-00${i}0`, { data: itemOf(d, new Date().toISOString()) })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      if (d.severity) expect((res.json.data.inbox as Record<string, unknown>).severity).toBe(d.severity)
    }
    // Агент пункт формы не создаст и не подделает: входящие пишет только владелец.
    expect((await bearer(agent).put('/db/items/i-20261021-120000-agnt', { data: itemOf(drafts[2]!, new Date().toISOString()) })).status).toBe(403)
    // С файлами: сколько ждать и что не уйдёт — схема входящего принимает поля формы как есть.
    const files = { expected: 3, failed: [{ name: 'big.log', reason: 'больше 20 МБ — обрежьте лог или пришлите ссылку текстом' }], fallbackText: '' }
    const withFiles = itemOf({ text: 'Вложение: отчёт.pdf и ещё 2', type: 'task', urgency: 'queue', files }, new Date().toISOString())
    expect((withFiles.inbox as Record<string, unknown>).filesExpected).toBe(3)
    const res = await bearer(owner).put('/db/items/i-20261021-120000-file', { data: withFiles })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
  })

  it('идея без важности и алерт с важностью проходят', async () => {
    expect((await bearer(owner).put('/db/items/i-idea', { data: inbox({ type: 'idea', severity: undefined, urgency: 'queue' }) })).status).toBe(200)
    expect((await bearer(owner).put('/db/items/i-alert', { data: inbox({ type: 'alert', severity: 'critical', urgency: 'now', origin: '@hrmhrhelper_space_allerting_bot', originKind: 'bot', forwarded: true }) })).status).toBe(200)
  })
})

describe('открытые пункты: GET /db/items?open=1 — правило страницы', () => {
  it('ответ, потом blocked — снова открыт; doing после ответа и ответ после blocked — закрыт; archived — нет', async () => {
    const a = bearer(agent), o = bearer(owner)
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const check = { kind: 'check', title: 'Проверка', body: 'Шаги', source: 'test' }
    for (const id of ['d-open-again', 'd-open-doing', 'd-open-before', 'd-open-new']) expect((await a.put(`/db/items/${id}`, { data: decision })).status).toBe(200)
    expect((await a.put('/db/items/d-open-arch', { data: { ...decision, archived: true } })).status).toBe(200)
    expect((await a.put('/db/items/c-open-again', { data: check })).status).toBe(200)
    // Владелец ответил минуту назад; сессия после ответа: blocked — нужна снова, doing — работает.
    for (const id of ['d-open-again', 'd-open-doing']) expect((await o.put(`/db/checks/${id}`, { data: { choice: 'yes', done: true, note: '', at: past } })).status).toBe(200)
    expect((await o.put('/db/checks/c-open-again', { data: { done: true, note: '', at: past } })).status).toBe(200)
    expect((await a.patch('/db/checks/d-open-again', { data: { agentStatus: 'blocked', agentNote: 'Ответьте ещё раз: пора или рано?' } })).status).toBe(200)
    expect((await a.patch('/db/checks/c-open-again', { data: { agentStatus: 'blocked', agentNote: 'Повторите шаг 2' } })).status).toBe(200)
    expect((await a.patch('/db/checks/d-open-doing', { data: { agentStatus: 'doing', agentNote: 'Принято, в работе' } })).status).toBe(200)
    // blocked раньше ответа: владелец ответил после — закрыт (agentAt ставит сервер, сейчас; ответ — позже).
    expect((await a.patch('/db/checks/d-open-before', { data: { agentStatus: 'blocked', agentNote: 'Жду решения' } })).status).toBe(200)
    expect((await o.patch('/db/checks/d-open-before', { data: { choice: 'yes', done: true, at: future } })).status).toBe(200)

    const res = await bearer(reader).get('/db/items?open=1')
    expect(res.status).toBe(200)
    expect(res.json.open).toBe(true)
    const ids = (res.json.docs as { id: string }[]).map((d) => d.id).filter((id) => /^[dc]-open-/.test(id)).sort()
    expect(ids).toEqual(['c-open-again', 'd-open-again', 'd-open-new'])
    // ETag — по items и checks (ревью #324, п. 9): без изменений — 304, ответ владельца меняет тег и список.
    const tag = res.headers.get('etag')!
    expect(tag).toBeTruthy()
    expect((await bearer(reader).get('/db/items?open=1', { 'If-None-Match': tag })).status).toBe(304)
    expect((await o.patch('/db/checks/d-open-new', { data: { choice: 'yes', done: true, at: future } })).status).toBe(200)
    const fresh = await bearer(reader).get('/db/items?open=1', { 'If-None-Match': tag })
    expect(fresh.status).toBe(200)
    expect((fresh.json.docs as { id: string }[]).some((d) => d.id === 'd-open-new')).toBe(false)
    // Без параметра и для других коллекций — прежний список с ETag.
    const all = await bearer(reader).get('/db/items')
    expect(all.json.open).toBeUndefined()
    expect((all.json.docs as { id: string }[]).some((d) => d.id === 'd-open-doing')).toBe(true)
    expect((await bearer(reader).get('/db/checks?open=1')).headers.get('etag')).toBeTruthy()
  })

  it('один документ: GET /db/items/:id — данные и версия; нет такого — 404', async () => {
    const got = await bearer(reader).get('/db/items/d-open-new')
    expect(got.status).toBe(200)
    expect(got.json).toMatchObject({ id: 'd-open-new', version: 1, data: { kind: 'decision', title: 'Решение' } })
    expect((await bearer(reader).get('/db/items/d-open-nope')).status).toBe(404)
    expect((await bearer(reader).get('/db/nope/d-open-new')).status).toBe(404)
  })
})

describe('области проверяются в каждом слое отдельно', () => {
  // Каждый слой должен держать свойство «читатель не пишет» сам: снятие проверки на маршруте или в хранилище
  // по отдельности должно ронять тест (мутационная проверка «Контроля», 19.10).
  const reader0 = { name: 'reader', scopes: ['read' as const], products: ['hr-helper'] }

  it('хранилище: запись и удаление без области agent/owner — 403 без HTTP', async () => {
    await expect(writeDoc(reader0, 'checks', 'x-store', {}, { merge: true })).rejects.toMatchObject({ status: 403 })
    await expect(writeDoc(reader0, 'items', 'x-store', decision, { merge: false })).rejects.toMatchObject({ status: 403 })
    await expect(deleteDoc({ name: 'agent', scopes: ['agent'], products: ['hr-helper'] }, 'items', 'd-test')).rejects.toMatchObject({ status: 403 })
  })

  it('маршрут: отказ по области раньше разбора тела и коллекции', async () => {
    // Без проверки на маршруте битый JSON дал бы 4xx разбора, а несуществующая коллекция — 404.
    const broken = await app.request('/api/oq/v1/db/checks/x-route', {
      method: 'PATCH', headers: { Authorization: `Bearer ${reader}`, 'Content-Type': 'application/json' }, body: '{битый',
    })
    expect(broken.status).toBe(403)
    const del = await app.request('/api/oq/v1/db/nope/x', { method: 'DELETE', headers: { Authorization: `Bearer ${agent}` } })
    expect(del.status).toBe(403)
  })
})

describe('страница /queue', () => {
  const HOST = 'ops.example.test:8797'
  const sha256 = (text: string, encoding: 'hex' | 'base64') => createHash('sha256').update(text, 'utf8').digest(encoding)
  const scriptSrc = (res: Response) =>
    (res.headers.get('content-security-policy') ?? '').split('; ').find((d) => d.startsWith('script-src ')) ?? ''
  const srcsOf = (html: string) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1] ?? '')

  it('без входа — на страницу входа; с сессией — скрипты файлами по порядку, CSP без nonce и unsafe-inline', async () => {
    const anon = await app.request('/queue')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toContain('/login')
    const res = await app.request('/queue', { headers: { Cookie: cookie, Host: HOST } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).not.toContain('nonce-')
    // Только каталог ассетов этого хоста (с портом) и хэш темы — не 'self': вложения отдаются с того же хоста.
    expect(scriptSrc(res)).toMatch(/^script-src ops\.example\.test:8797\/queue\/assets\/ 'sha256-[A-Za-z0-9+/]+=*'$/)
    const html = await res.text()
    // Инлайн — только тема в <head>, до первой отрисовки; её sha256 — тот, что в CSP.
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
    expect(inline).toHaveLength(1)
    const theme = inline[0] ?? ''
    expect(theme).toContain("localStorage.getItem('owner-queue-theme')")
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<main'))
    expect(scriptSrc(res)).toContain(`'sha256-${sha256(theme, 'base64')}'`)
    // Внешние — после </main>, порядок прежний: подмена базы, правило «открыт ли пункт» (то же, что у ?open=1),
    // вложения (форма и карточки берут window.__oqFiles при запуске), код страницы, кнопки мёржа.
    const srcs = srcsOf(html)
    expect(srcs.map((s) => s.replace(/^\/queue\/assets\/([a-z-]+)\.[0-9a-f]{16}\.js$/, '$1'))).toEqual([
      'shim', 'open-rule', 'files', 'page', 'enhance', 'products',
    ])
    expect(html.indexOf(srcs[0] ?? '<нет>')).toBeGreaterThan(html.indexOf('</main>'))
    const bodies = await Promise.all(srcs.map(async (s) => (await app.request(s, { headers: { Cookie: cookie } })).text()))
    expect(bodies[0]).toContain('window.claude = { use:')
    expect(bodies[1]).toContain('function oqItemState(')
    expect(bodies[2]).toContain('window.__oqFiles = {')
    expect(bodies[3]).toContain('var ITEMS')
    expect(bodies[4]).toContain('oq-merge')
  })

  it('файл скрипта — с той же авторизацией, кэшируется надолго, имя несёт хэш содержимого', async () => {
    const html = await (await app.request('/queue', { headers: { Cookie: cookie } })).text()
    const src = srcsOf(html).find((s) => s.includes('/page.')) ?? ''
    const res = await app.request(src, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(src).toContain(`.${sha256(await res.text(), 'hex').slice(0, 16)}.js`)
    const anon = await app.request(src)
    expect(anon.status).toBe(401)
    expect(anon.headers.get('cache-control')).toBe('no-store')
    expect((await app.request(src, { headers: { Authorization: `Bearer ${reader}` } })).status).toBe(200)
    expect((await app.request('/queue/assets/page.0000000000000000.js', { headers: { Cookie: cookie } })).status).toBe(404)
  })

  it('Host не похож на имя и порт — в CSP не попадает, остаётся \'self\'', async () => {
    const res = await app.request('/queue', { headers: { Cookie: cookie, Host: "evil.test; script-src *" } })
    expect(res.status).toBe(200)
    expect(scriptSrc(res)).toMatch(/^script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'$/)
  })

  it('токен бота открывает страницу и её скрипты заголовком Authorization', async () => {
    const res = await app.request('/queue', { headers: { Authorization: `Bearer ${owner}` } })
    expect(res.status).toBe(200)
    for (const src of srcsOf(await res.text())) {
      expect((await app.request(src, { headers: { Authorization: `Bearer ${owner}` } })).status).toBe(200)
    }
  })
})

describe('ответ владельца со страницы не стирает поля агента (линза GLM #214, major)', () => {
  const pageHtml = readFileSync(join(__dirname, '../server/queue/page.html'), 'utf8')
  type SaveOwnerAnswer = (db: unknown, id: string, e: Record<string, unknown>, base?: string) => Promise<unknown>
  // Код страницы как в браузере: подмена базы (SHIM_JS) и блок oq-pure из page.html; fetch уходит в приложение
  // с сессией владельца — так же, как из вкладки консоли и из страницы, которую открывает бот.
  function queuePage() {
    const win: { claude?: { use: (cap: string) => Promise<unknown> } } = {}
    const ctx = createContext({
      window: win, console, setTimeout, clearTimeout,
      document: { hidden: false, addEventListener() {} },
      fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
        app.request(url, { method: init.method, headers: { ...init.headers, Cookie: cookie }, body: init.body }),
    })
    runInContext(SHIM_JS, ctx)
    runInContext(OPEN_RULE_JS, ctx)
    runInContext(pageHtml.slice(pageHtml.indexOf('/* oq-pure:start'), pageHtml.indexOf('/* oq-pure:end */')), ctx)
    return { db: () => win.claude!.use('db'), saveOwnerAnswer: ctx.saveOwnerAnswer as SaveOwnerAnswer }
  }

  it('агент взял входящее, владелец ответил — agentStatus, agentNote, agentBy и agentAt на месте, захват держится', async () => {
    const id = 'i-20261023-0600-5f01'
    expect((await bearer(owner).put(`/db/items/${id}`, { data: inbox() })).status).toBe(200)
    const took = await bearer(agent).patch(`/db/checks/${id}`, { data: { agentStatus: 'taken', agentNote: 'беру', agentBy: 'hr-helper-v2-5f' } })
    expect(took.status).toBe(200)
    const page = queuePage()
    // Запись страницы — как после снимка опроса: apply() копирует в неё и поля агента, здесь — устаревшие.
    const e = { done: true, choice: 'yes', note: 'проверил', at: '2026-10-23T06:00:00.000Z', agentStatus: 'planned', agentNote: 'старое', agentAt: '2000-01-01T00:00:00.000Z' }
    await page.saveOwnerAnswer(await page.db(), id, e)
    const doc = await bearer(agent).get(`/db/checks/${id}`)
    expect(doc.json.data).toEqual({
      done: true, choice: 'yes', note: 'проверил', at: '2026-10-23T06:00:00.000Z',
      agentStatus: 'taken', agentNote: 'беру', agentBy: 'hr-helper-v2-5f', agentAt: took.json.data.agentAt,
      ownerAt: expect.any(String),
    })
    // Захват входящего пережил ответ владельца: другая сессия пункт не берёт.
    expect((await bearer(agent).patch(`/db/checks/${id}`, { data: { agentStatus: 'taken', agentBy: 'hr-helper-v2-44' } })).status).toBe(409)
  })

  it('страница сохраняет ответ только через saveOwnerAnswer — замены (set) по checks в коде страницы нет', () => {
    expect(pageHtml).toContain('remote = { save: function (id, e, base) { return saveOwnerAnswer(db, id, e, base); } };')
    expect(pageHtml).toContain("await remote.save(id, entry(id), entry(id).base || '');")
    expect(pageHtml).not.toMatch(/doc\('checks\/' \+ id\)\.set\(/)
  })

  it('повтор старого ответа после нового — 409, в базе новый (ревью «Контроля» #324, п. 1)', async () => {
    const id = 'd-cas-324'
    expect((await bearer(agent).put(`/db/items/${id}`, { data: { kind: 'check', title: 'CAS' } })).status).toBe(200)
    const page = queuePage()
    const db = await page.db()
    const A = { done: true, choice: 'a', note: '', at: '2026-10-23T07:00:00.000Z' }
    const B = { done: true, choice: 'b', note: '', at: '2026-10-23T07:05:00.000Z' }
    // Вкладка 1 ответила «A», ответ сохранился; вкладка 2 (телефон) видела «A» и ответила «B».
    await page.saveOwnerAnswer(db, id, A, '')
    await page.saveOwnerAnswer(db, id, B, A.at)
    // Вкладка бота повторяет старую правку «A» от пустой базы — отказ, а не тихая перезапись.
    await expect(page.saveOwnerAnswer(db, id, A, '')).rejects.toMatchObject({ status: 409 })
    // И повтор «A» от базы «A» (правка «A» начата до «B») — тоже отказ.
    await expect(page.saveOwnerAnswer(db, id, { ...A, note: 'дополнил' }, A.at)).rejects.toMatchObject({ status: 409 })
    expect((await bearer(agent).get(`/db/checks/${id}`)).json.data).toMatchObject({ choice: 'b', at: B.at })
    // Без ifAnswerAt (старая вкладка и MCP) запись идёт как раньше.
    expect((await bearer(owner).patch(`/db/checks/${id}`, { data: { note: 'вручную' } })).status).toBe(200)
  })

  it('ownerAt и blockedAt ставит сервер: blockedAt — только при переходе в blocked; присланные значения не принимаются', async () => {
    const id = 'c-stamps-324'
    expect((await bearer(agent).put(`/db/items/${id}`, { data: { kind: 'check', title: 'Отметки' } })).status).toBe(200)
    const fake = '2000-01-01T00:00:00.000Z'
    expect((await bearer(owner).patch(`/db/checks/${id}`, { data: { done: true, at: '2099-01-01T00:00:00.000Z', ownerAt: fake } })).status).toBe(200)
    const answered = (await bearer(agent).get(`/db/checks/${id}`)).json.data
    expect(answered.ownerAt).toEqual(expect.any(String))
    expect(answered.ownerAt).not.toBe(fake)
    const blocked = await bearer(agent).patch(`/db/checks/${id}`, { data: { agentStatus: 'blocked', agentNote: 'нужен вывод', ownerAt: fake, blockedAt: fake } })
    expect(blocked.status).toBe(200)
    expect(blocked.json.data.ownerAt).toBe(answered.ownerAt)
    expect(blocked.json.data.blockedAt).not.toBe(fake)
    // Заметка поверх blocked — отметка не сдвигается: пункт не переоткрывается от любой записи агента.
    const note = await bearer(agent).patch(`/db/checks/${id}`, { data: { agentNote: 'взял' } })
    expect(note.json.data.blockedAt).toBe(blocked.json.data.blockedAt)
  })

  it('замена ответа владельцем (PUT) не стирает поля агента (ревью «Контроля» #324, п. 5)', async () => {
    const id = 'c-put-324'
    expect((await bearer(agent).put(`/db/items/${id}`, { data: { kind: 'check', title: 'PUT' } })).status).toBe(200)
    const took = await bearer(agent).patch(`/db/checks/${id}`, { data: { agentStatus: 'doing', agentNote: 'делаю', agentBy: 'hr-helper-v2-5f' } })
    const put = await bearer(owner).put(`/db/checks/${id}`, { data: { done: true, at: '2026-10-23T08:00:00.000Z' } })
    expect(put.status).toBe(200)
    expect(put.json.data).toMatchObject({ done: true, agentStatus: 'doing', agentNote: 'делаю', agentBy: 'hr-helper-v2-5f', agentAt: took.json.data.agentAt })
  })
})

describe('мёрж из очереди', () => {
  const SHA = 'a'.repeat(40)
  let deployRunning = false
  let lastPut: { path: string; body: any } | null = null
  const calls: string[] = []
  const github = async (method: string, path: string, _token: string, body?: unknown): Promise<GithubResponse> => {
    calls.push(`${method} ${path}`)
    if (method === 'GET' && path.endsWith('/pulls/162')) {
      return { status: 200, text: JSON.stringify({ number: 162, title: 'Запись о закрытии', state: 'open', mergeable: true, html_url: 'https://github.com/x/pull/162', head: { sha: SHA, ref: 'docs/close-p0' }, base: { ref: 'main' } }) }
    }
    if (method === 'GET' && path.includes('/actions/workflows/')) return { status: 200, text: JSON.stringify({ workflow_runs: [{ status: deployRunning ? 'in_progress' : 'completed' }] }) }
    if (method === 'GET' && path.endsWith('/pulls/162/commits?per_page=100')) {
      return { status: 200, text: JSON.stringify([{ commit: { message: 'feat(oq): поля мёржа [skip ci]' } }, { commit: { message: 'test: squash\n\n[ci skip] тело' } }]) }
    }
    if (method === 'PUT' && path.endsWith('/pulls/162/merge')) { lastPut = { path, body }; return { status: 200, text: JSON.stringify({ sha: 'b'.repeat(40), merged: true }) } }
    return { status: 404, text: '{}' }
  }
  /** POST /merge с версией пункта, как шлют страница и бот после экрана подтверждения. */
  const post = async (id: string, sha: string) => {
    const version = (await bearer(agent).get(`/db/items/${id}`)).json.version as number
    return bearer(owner).post(`/merge/${id}`, { sha, version })
  }

  beforeAll(async () => {
    const gh = await getGithubSettings()
    await writeSetting('github', { ...gh, mergeTokenEnc: encryptSecret('github_pat_test_0000000000000000000000') })
    await bearer(agent).put('/db/items/m-162', { data: { kind: 'merge', title: '#162 — без деплоя', sha: SHA, base: 'main', cmd: 'gh pr merge 162 --merge --subject "Merge pull request #162 from agolubenk/docs/close-p0 [skip ci]"' } })
    await bearer(agent).put('/db/items/m-170', { data: { kind: 'merge', title: '#170 — код', pr: 162, sha: SHA, base: 'main' } })
    await bearer(agent).put('/db/items/m-171', { data: { kind: 'merge', title: '#162 — вердикта ещё нет', pr: 162 } })
    await bearer(agent).put('/db/items/m-172', { data: { kind: 'merge', title: '#162 — одобрена другая голова', pr: 162, sha: 'd'.repeat(40), base: 'main' } })
    await bearer(agent).put('/db/items/m-174', { data: { kind: 'merge', title: '#162 — одобрен для склейки', pr: 162, sha: SHA, base: 'review/ai-bundle' } })
    await bearer(agent).put('/db/items/m-175', { data: { kind: 'merge', title: '#162 — голова без базы', pr: 162, sha: SHA } })
    // Q-29: tAIBE #162 с вердиктом — в команде (как писали до поля repo) и в поле.
    await bearer(agent).put('/db/items/m-taibe-162', { data: { kind: 'merge', title: 'tAIBE #162', sha: SHA, base: 'board-agents', cmd: `gh pr merge 162 -R agolubenk/tAIBE --squash --match-head-commit ${SHA}` } })
    await bearer(agent).put('/db/items/m-taibe-163', { data: { kind: 'merge', title: 'tAIBE #162', pr: 162, repo: 'agolubenk/tAIBE', sha: SHA, base: 'board-agents' } })
    // Свой репозиторий в другом регистре — не чужой; Q-30: squash и свой заголовок.
    await bearer(agent).put('/db/items/m-177', { data: { kind: 'merge', title: '#162 — squash', pr: 162, repo: 'AGOLUBENK/hr_helper-v2', mergeMethod: 'squash', subject: 'feat(oq): пункт мёржа (#162)', sha: SHA, base: 'main' } })
    // Ревью Q-29: репозиторий без -R — из cd, GH_REPO, URL PR и слитного -R.
    await bearer(agent).put('/db/items/m-taibe-164', { data: { kind: 'merge', title: 'tAIBE #162', sha: SHA, base: 'board-agents', cmd: 'cd ~/Desktop/Development/tAIBE && gh pr merge 162 --squash' } })
    await bearer(agent).put('/db/items/m-taibe-165', { data: { kind: 'merge', title: 'tAIBE #162', sha: SHA, base: 'board-agents', cmd: 'GH_REPO=agolubenk/tAIBE gh pr merge 162 --squash' } })
    await bearer(agent).put('/db/items/m-taibe-166', { data: { kind: 'merge', title: 'tAIBE #162', sha: SHA, base: 'board-agents', cmd: 'gh pr merge https://github.com/agolubenk/tAIBE/pull/162 --squash' } })
    await bearer(agent).put('/db/items/m-taibe-167', { data: { kind: 'merge', title: 'tAIBE #162', sha: SHA, base: 'board-agents', cmd: 'gh pr merge 162 -Ragolubenk/tAIBE -ds' } })
  })

  it('PR другого репозитория (-R в команде или поле repo) — 409 до запроса к GitHub, а не одноимённый PR консоли (Q-29)', async () => {
    setGithubTransportForTests(github)
    calls.length = 0
    for (const id of ['m-taibe-162', 'm-taibe-163', 'm-taibe-165', 'm-taibe-166', 'm-taibe-167']) {
      const info = await bearer(owner).get(`/merge/${id}`)
      expect(info.status, id).toBe(409)
      expect(info.json.error).toContain('в репозитории agolubenk/tAIBE')
      expect(info.json.error).toContain('в терминале')
      expect((await post(id, SHA)).status).toBe(409)
    }
    // cd в другую папку: репозиторий не ясен — отказ, а не PR консоли с тем же номером.
    const cd = await bearer(owner).get('/merge/m-taibe-164')
    expect(cd.status).toBe(409)
    expect(cd.json.error).toContain('(cd)')
    expect(calls).toEqual([])
    expect(lastPut).toBeNull()
    const own = await bearer(owner).get('/merge/m-177')
    expect(own.status).toBe(200)
    expect(own.json).toMatchObject({ repo: 'agolubenk/HR_Helper-v2', method: 'squash', subject: 'feat(oq): пункт мёржа (#162)', approval: 'ok' })
  })

  it('способ, заголовок и репозиторий: поля пункта и флаги только самой команды gh pr merge (Q-30)', async () => {
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --squash --subject "fix: a; b | c" && curl -s https://x' })).toMatchObject({ pr: 5, method: 'squash', subject: 'fix: a; b | c', repo: null })
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --merge && curl -s https://x -t 1' })).toMatchObject({ method: 'merge', subject: null })
    expect(mergePlan({ kind: 'merge', cmd: "gh pr merge 5 -s -t 'docs: x [skip ci]' --repo=agolubenk/tAIBE" })).toMatchObject({ method: 'squash', subject: 'docs: x [skip ci]', skipCi: true, repo: 'agolubenk/tAIBE' })
    // Флаг внутри значения в кавычках — часть значения, не флаг (ревью линзы ресурсов).
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --merge --subject "fix -s flag"' })).toMatchObject({ method: 'merge', subject: 'fix -s flag' })
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --body "use -t x, see -R other/repo" --subject "real"' })).toMatchObject({ subject: 'real', repo: null })
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --repo' })).toMatchObject({ repo: null })
    // Поле пункта главнее команды.
    expect(mergePlan({ kind: 'merge', mergeMethod: 'merge', subject: 'x', cmd: 'gh pr merge 5 --squash --subject "y"' })).toMatchObject({ method: 'merge', subject: 'x' })
    for (const data of [{ subject: 'a\nb' }, { mergeMethod: 'rebase' }, { repo: 'tAIBE' }]) {
      expect((await bearer(agent).put('/db/items/m-178', { data: { kind: 'merge', title: '#5', pr: 5, ...data } })).status).toBe(422)
    }
  })

  it('команда, которую консоль не повторит как терминал, — problem и 409; репозиторий — из -R, URL, GH_REPO (ревью Q-29/Q-30)', () => {
    const plan = (cmd: string, extra: Record<string, unknown> = {}) => mergePlan({ kind: 'merge', cmd, ...extra })
    expect(plan('cd ~/Desktop/Development/tAIBE && gh pr merge 41')).toMatchObject({ pr: 41, repo: null, problem: expect.stringContaining('(cd)') })
    expect(plan('cd ~/x && gh pr merge 41', { repo: 'agolubenk/HR_Helper-v2' })).toMatchObject({ repo: 'agolubenk/HR_Helper-v2', problem: null })
    expect(plan('GH_REPO=agolubenk/tAIBE gh pr merge 41')).toMatchObject({ repo: 'agolubenk/tAIBE', problem: null })
    expect(plan('gh pr merge https://github.com/agolubenk/tAIBE/pull/41 --squash')).toMatchObject({ pr: 41, repo: 'agolubenk/tAIBE', method: 'squash' })
    expect(plan('gh pr merge 41 -Ragolubenk/tAIBE')).toMatchObject({ repo: 'agolubenk/tAIBE' })
    expect(plan('gh pr merge 41 -R=agolubenk/tAIBE')).toMatchObject({ repo: 'agolubenk/tAIBE' })
    expect(plan('gh pr merge 41 -R github.com/agolubenk/HR_Helper-v2')).toMatchObject({ repo: 'agolubenk/HR_Helper-v2', problem: null })
    expect(plan('gh pr merge #41 -ds')).toMatchObject({ pr: 41, method: 'squash', problem: null })
    expect(plan('gh pr merge 41 --rebase')).toMatchObject({ problem: expect.stringContaining('rebase') })
    expect(plan('gh pr merge 41 -r', { mergeMethod: 'merge' })).toMatchObject({ method: 'merge', problem: null })
    expect(plan('gh pr merge 41 --squash --merge').problem).toContain('несколько способов')
    // gh взял бы «--squash» значением -t: это опечатка — отказ, а не заголовок «--squash».
    expect(plan('gh pr merge 41 -t --squash')).toMatchObject({ subject: null, problem: expect.stringContaining('нет значения') })
    expect(plan('gh pr merge 41 --subject')).toMatchObject({ subject: null, problem: expect.stringContaining('нет значения') })
    expect(plan('gh pr merge 41 --squash --subject "$(git log -1 --format=%s)"')).toMatchObject({ subject: null, problem: expect.stringContaining('подстановка') })
    expect(plan('gh pr merge 41 --squash --subject `date`').problem).toContain('подстановка')
    expect(plan("gh pr merge 41 --squash --subject 'cost $5 fix'")).toMatchObject({ subject: 'cost $5 fix', problem: null })
    expect(plan('gh pr merge 41 --squash --subject "$(x)"', { subject: 'feat: y' })).toMatchObject({ subject: 'feat: y', problem: null })
    expect(plan('gh pr merge 41 -R agolubenk/tAIBE', { repo: 'agolubenk/HR_Helper-v2' }).problem).toContain('разные репозитории')
    expect(plan('GH_REPO=a/b gh pr merge 41 -R c/d').problem).toContain('разные репозитории')
    // Тело (--body) с «-R x/y» — значение, не флаг.
    expect(plan('gh pr merge 41 -b "see -R other/repo" --squash')).toMatchObject({ repo: null, method: 'squash', problem: null })
  })

  it('перенаправления shell (2>&1, 2>/dev/null, > файл, &>) — не аргументы мёржа (ревью «Контроля» #114, F1)', () => {
    const plan = (cmd: string) => mergePlan({ kind: 'merge', cmd })
    const sha = 'a'.repeat(40)
    // Форма реального пункта m-537: строка отвечает с 2>&1 — консоль вливает, а не 409.
    expect(plan(`gh pr merge 537 --squash --match-head-commit ${sha} --subject "fix(calendar): IS-221 (#537)" 2>&1`))
      .toMatchObject({ pr: 537, method: 'squash', subject: 'fix(calendar): IS-221 (#537)', repo: null, problem: null })
    expect(plan(`gh pr merge 114 -R agolubenk/tAIBE --squash --match-head-commit ${sha} 2>&1`))
      .toMatchObject({ pr: 114, repo: 'agolubenk/tAIBE', method: 'squash', problem: null })
    expect(plan('gh pr merge 5 --squash 2>/dev/null')).toMatchObject({ pr: 5, problem: null })
    expect(plan('gh pr merge 5 &>merge.log')).toMatchObject({ pr: 5, problem: null })
    expect(plan('gh pr merge 5 2>&1 | tee merge.log')).toMatchObject({ pr: 5, problem: null })
    // Флаги после перенаправления gh тоже видит; у голого оператора цель — следующее слово.
    expect(plan('gh pr merge 5 2>&1 --squash')).toMatchObject({ pr: 5, method: 'squash', problem: null })
    expect(plan('gh pr merge 5 > merge.log --squash -t "x"')).toMatchObject({ pr: 5, method: 'squash', subject: 'x', problem: null })
    // Цепочка из двух мёржей с 2>&1 — по-прежнему отказ; «>x» в кавычках — буквальный аргумент.
    expect(plan('gh pr merge 534 2>&1 && sleep 5 && gh pr merge 535 2>&1').problem).toContain('2 мёржа')
    expect(plan('gh pr merge 5 ">x"').problem).toContain('больше одного аргумента')
  })

  it('разбор не пропускает то, что gh поймёт иначе: хвост URL, флаги до merge, cd в кавычках, два мёржа, \\\' (ревью Q-29/Q-30, проход 2)', () => {
    const plan = (cmd: string, extra: Record<string, unknown> = {}) => mergePlan({ kind: 'merge', cmd, ...extra })
    // (a) URL PR с хвостом — репозиторий из URL, как у gh.
    expect(plan('gh pr merge https://github.com/agolubenk/tAIBE/pull/41/files --squash')).toMatchObject({ pr: 41, repo: 'agolubenk/tAIBE' })
    expect(plan('gh pr merge https://github.com/agolubenk/tAIBE/pull/41#issuecomment-1')).toMatchObject({ pr: 41, repo: 'agolubenk/tAIBE' })
    // Аргумент, который консоль не разбирает (ветка, чужой URL), — отказ; поле repo снимает его.
    expect(plan('gh pr merge feat/x', { pr: 41 }).problem).toContain('не разбирает')
    expect(plan('gh pr merge https://gitlab.com/a/b/-/merge_requests/41', { pr: 41 }).problem).toContain('не разбирает')
    expect(plan('gh pr merge feat/x', { pr: 41, repo: 'agolubenk/HR_Helper-v2' }).problem).toBeNull()
    expect(plan('gh pr merge 41 42').problem).toContain('больше одного аргумента')
    // (b) флаги `gh pr` до merge и лишние пробелы.
    expect(plan('gh pr -R agolubenk/tAIBE merge 41')).toMatchObject({ pr: 41, repo: 'agolubenk/tAIBE', problem: null })
    expect(plan('gh pr  merge 41 -R agolubenk/tAIBE')).toMatchObject({ pr: 41, repo: 'agolubenk/tAIBE' })
    expect(plan('gh pr view 41 && gh pr merge 41 --squash')).toMatchObject({ pr: 41, method: 'squash', problem: null })
    // Не разобрали мёрж вовсе — отказ, пока поле repo не скажет, куда.
    expect(plan('gh api -X PUT repos/agolubenk/tAIBE/pulls/41/merge', { pr: 41 }).problem).toContain('не разобрала')
    // (c) cd внутри кавычек: gh тоже выполнится в другой папке.
    expect(plan('bash -c "cd ~/tAIBE && gh pr merge 41"').problem).toContain('(cd)')
    expect(plan("ssh vps 'cd /srv/tAIBE && gh pr merge 41'").problem).toContain('(cd)')
    // (d) экранированная кавычка не обрывает разбор; кавычка без пары — отказ.
    expect(plan("gh pr merge 41 --subject it\\'s -R agolubenk/tAIBE")).toMatchObject({ subject: "it's", repo: 'agolubenk/tAIBE', problem: null })
    expect(plan('gh pr merge 41 --subject "a \\"b\\" c" --squash')).toMatchObject({ subject: 'a "b" c', method: 'squash' })
    expect(plan("gh pr merge 41 --subject it's -R agolubenk/tAIBE").problem).toContain('без пары')
    expect(plan('gh pr merge 41 --subject "\\$HOME"')).toMatchObject({ subject: '$HOME', problem: null })
    // Два мёржа в одной команде — консоль вольёт один, пункт выглядел бы законченным: отказ, поля его не снимают.
    expect(plan('gh pr merge 480 --squash && gh pr merge 481 --squash', { pr: 480, repo: 'agolubenk/HR_Helper-v2', mergeMethod: 'squash' }).problem).toContain('2 мёржа')
    // Поле pr и команда называют разные PR.
    expect(plan('gh pr merge 42', { pr: 41 }).problem).toContain('разные PR')
  })

  it('все метки пропуска CI GitHub — без деплоя; метка только в поле subject; метка вне самой команды мёржа не в счёт (ревью Q-29/Q-30)', () => {
    for (const m of ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']) {
      expect(mergePlan({ kind: 'merge', cmd: `gh pr merge 5 --squash --subject "docs: x ${m}"` }), m).toMatchObject({ skipCi: true, deploys: false })
      expect(mergePlan({ kind: 'merge', pr: 5, subject: `docs: y ${m}` }), m).toMatchObject({ skipCi: true, deploys: false })
    }
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --squash && git commit -m "x [skip ci]"' })).toMatchObject({ skipCi: false, deploys: true })
    // Шестой способ GitHub — трейлер skip-checks: true в теле.
    expect(mergePlan({ kind: 'merge', cmd: 'gh pr merge 5 --squash --body "x\n\n\nskip-checks: true"' })).toMatchObject({ skipCi: true, deploys: false })
  })

  it('тело мёржа: заголовок и текст всегда явно, [skip ci] дописывается, с деплоем метки вычищены (ревью Q-29/Q-30)', () => {
    const base = { pr: 7, title: 'feat: x', headRef: 'feat/x', repo: 'agolubenk/HR_Helper-v2', skipCi: false, method: 'merge' as const, subject: null }
    expect(mergeRequestBody(base, SHA)).toEqual({ sha: SHA, merge_method: 'merge', commit_title: 'Merge pull request #7 from agolubenk/feat/x', commit_message: 'feat: x' })
    expect(mergeRequestBody({ ...base, method: 'squash', subject: 'feat: x (#7)' }, SHA)).toEqual({ sha: SHA, merge_method: 'squash', commit_title: 'feat: x (#7)', commit_message: 'feat: x' })
    // HR: squash_merge_commit_message = COMMIT_MESSAGES — [skip ci] из коммита ветки отменил бы обещанный деплой.
    const squashed = mergeRequestBody({ ...base, method: 'squash', title: 'feat: x [skip ci]' }, SHA, ['fix: a [skip ci]', 'docs: b\n\n[ci skip] [no ci] тело'])
    expect(squashed).toEqual({ sha: SHA, merge_method: 'squash', commit_title: 'feat: x (#7)', commit_message: '* fix: a\n\n* docs: b\n\n тело' })
    expect(mergeRequestBody({ ...base, title: 'feat: x [skip actions]' }, SHA)).toMatchObject({ commit_title: 'Merge pull request #7 from agolubenk/feat/x', commit_message: 'feat: x' })
    expect(mergeRequestBody({ ...base, method: 'squash', skipCi: true }, SHA)).toMatchObject({ merge_method: 'squash', commit_title: 'feat: x (#7) [skip ci]' })
    expect(mergeRequestBody({ ...base, skipCi: true }, SHA)).toMatchObject({ commit_title: 'Merge pull request #7 from agolubenk/feat/x [skip ci]' })
    expect(mergeRequestBody({ ...base, skipCi: true, subject: 'docs: y [SKIP CI]' }, SHA)).toMatchObject({ commit_title: 'docs: y [SKIP CI]' })
    expect(mergeRequestBody({ ...base, skipCi: true, subject: 'docs: y [no ci]' }, SHA)).toMatchObject({ commit_title: 'docs: y [no ci]' })
    // Вложенная метка: один проход replace оставил бы «[skip ci]» и тихо отменил деплой (ревью безопасности).
    const nested = mergeRequestBody({ ...base, method: 'squash', subject: 'x [sk[skip ci]ip ci]' }, SHA, ['fix: a [ci [no ci] skip]'])
    expect(nested).toMatchObject({ commit_title: 'x', commit_message: '* fix: a' })
    expect(String(nested.commit_title) + String(nested.commit_message)).not.toMatch(/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i)
    expect(mergeRequestBody({ ...base, title: 'feat: x [skip [skip ci] actions]' }, SHA)).toMatchObject({ commit_message: 'feat: x' })
    // Трейлер skip-checks: true в коммите ветки отменил бы деплой так же, как метка в скобках.
    const trailer = mergeRequestBody({ ...base, method: 'squash' }, SHA, ['fix: a\n\n\nskip-checks: true', 'fix: b\n\nSkip-Checks:true'])
    expect(String(trailer.commit_message)).not.toMatch(/skip-checks/i)
  })

  it('вердикт «Контроля»: экран подтверждения говорит ok / missing / mismatch / base', async () => {
    setGithubTransportForTests(github)
    expect((await bearer(owner).get('/merge/m-162')).json).toMatchObject({ approval: 'ok', approvedSha: SHA, approvedBase: 'main' })
    expect((await bearer(owner).get('/merge/m-171')).json).toMatchObject({ approval: 'missing', approvedSha: null })
    expect((await bearer(owner).get('/merge/m-175')).json).toMatchObject({ approval: 'missing', approvedSha: SHA, approvedBase: null })
    expect((await bearer(owner).get('/merge/m-172')).json).toMatchObject({ approval: 'mismatch', approvedSha: 'd'.repeat(40), headSha: SHA })
    expect((await bearer(owner).get('/merge/m-174')).json).toMatchObject({ approval: 'base', approvedBase: 'review/ai-bundle', baseRef: 'main' })
  })

  it('без вердикта, с чужой головой или чужой базой мёрж — 409, GitHub не вызывается (20.10: #248 влит до вердикта)', async () => {
    setGithubTransportForTests(github)
    const missing = await post('m-171', SHA)
    expect(missing.status).toBe(409)
    expect(missing.json.error).toContain('нет вердикта «Контроля»')
    expect((await post('m-175', SHA)).status).toBe(409)
    const mismatch = await post('m-172', SHA)
    expect(mismatch.status).toBe(409)
    expect(mismatch.json.error).toContain('нужен новый вердикт')
    const base = await post('m-174', SHA)
    expect(base.status).toBe(409)
    expect(base.json.error).toContain('для базы «review/ai-bundle»')
    expect(lastPut).toBeNull()
  })

  it('одобренная голова — только полный SHA: короткий в пункте не засчитался бы молча', async () => {
    const res = await bearer(agent).put('/db/items/m-173', { data: { kind: 'merge', title: '#162', pr: 162, sha: 'aaaaaaa' } })
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.json)).toContain('полный SHA')
    // Пункт, записанный в обход схемы (старый импорт, правка базы), короткий sha тоже не делает одобрением.
    expect(mergePlan({ kind: 'merge', pr: 162, sha: 'aaaaaaa' }).approvedSha).toBeNull()
    expect(mergePlan({ kind: 'merge', pr: 162, sha: SHA }).approvedSha).toBe(SHA)
    expect(mergePlan({ kind: 'merge', pr: 162, base: 'main; rm -rf' }).approvedBase).toBeNull()
    expect((await bearer(agent).put('/db/items/m-176', { data: { kind: 'merge', title: '#162', pr: 162, sha: SHA, base: 'ma in' } })).status).toBe(422)
  })

  it('агенту мёрж недоступен', async () => {
    setGithubTransportForTests(github)
    expect((await bearer(agent).get('/merge/m-162')).status).toBe(403)
  })

  it('экран подтверждения: PR, SHA, без деплоя по [skip ci]', async () => {
    setGithubTransportForTests(github)
    const info = await bearer(owner).get('/merge/m-162')
    expect(info.status).toBe(200)
    expect(info.json).toMatchObject({ pr: 162, headSha: SHA, skipCi: true, deploys: false, deployRunning: false })
    const code = await bearer(owner).get('/merge/m-170')
    expect(code.json).toMatchObject({ skipCi: false, deploys: true })
  })

  it('мёрж кода без пометок считается деплоем: во время деплоя запрещён; допушенный SHA — отказ', async () => {
    setGithubTransportForTests(github)
    deployRunning = true
    const busy = await post('m-170', SHA)
    expect(busy.status).toBe(409)
    expect(busy.json.error).toContain('деплой')
    deployRunning = false
    const moved = await post('m-162', 'c'.repeat(40))
    expect(moved.status).toBe(409)
    expect(lastPut).toBeNull()
  })

  it('мёрж по SHA с [skip ci], ответ владельца отмечен, второй подряд — 429', async () => {
    setGithubTransportForTests(github)
    const res = await post('m-162', SHA)
    expect(res.status).toBe(200)
    expect(lastPut!.body).toMatchObject({ sha: SHA, merge_method: 'merge' })
    // Заголовок из --subject команды — как есть, без второго [skip ci].
    expect(lastPut!.body.commit_title).toBe('Merge pull request #162 from agolubenk/docs/close-p0 [skip ci]')
    expect(res.json.message).toContain('merge')
    const check = await bearer(agent).get('/db/checks/m-162')
    expect(check.json.data.done).toBe(true)
    expect((await post('m-162', SHA)).status).toBe(429)
  })

  it('POST без версии пункта — 422, с устаревшей — 409: способ и деплой не подменить между показом и кликом (ревью Q-29/Q-30)', async () => {
    setGithubTransportForTests(github)
    lastPut = null
    expect((await bearer(owner).post('/merge/m-170', { sha: SHA })).status).toBe(422)
    const shown = (await bearer(owner).get('/merge/m-170')).json.version as number
    await bearer(agent).put('/db/items/m-170', { data: { kind: 'merge', title: '#170 — код', pr: 162, sha: SHA, base: 'main', deploy: 'skip' } })
    const stale = await bearer(owner).post('/merge/m-170', { sha: SHA, version: shown })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('изменился после показа')
    expect(lastPut).toBeNull()
  })

  it('squash через мёрж: заголовок из пункта, текст из коммитов ветки без меток пропуска CI, деплой (ревью Q-29/Q-30)', async () => {
    setGithubTransportForTests(github)
    calls.length = 0
    const res = await post('m-177', SHA)
    expect(res.status).toBe(200)
    expect(calls).toContain('GET /repos/agolubenk/HR_Helper-v2/pulls/162/commits?per_page=100')
    expect(lastPut!.body).toEqual({ sha: SHA, merge_method: 'squash', commit_title: 'feat(oq): пункт мёржа (#162)', commit_message: '* feat(oq): поля мёржа\n\n* test: squash\n\n тело' })
    expect(res.json.message).toContain('squash')
    expect(res.json.message).toContain('запущен деплой прода')
  })
})
