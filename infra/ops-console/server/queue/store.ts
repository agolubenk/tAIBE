/**
 * Документы очереди владельца (checks · items · work) и правила записи — то, что в артефакте держалось
 * на дисциплине агентов, здесь проверяет сервер:
 *  - ответ владельца (done, choice, note, at) пишет только владелец; агент — только agentStatus/agentNote;
 *  - planEnd задачи агент не переписывает без basePlanEnd (от planEnd считается отставание);
 *  - ifVersion — защита от одновременной правки (409 вместо молчаливой перезаписи).
 * Каждое изменение — строка журнала oq_events.
 */
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { oqDocs, oqEvents } from '../db/schema'
import { apiError } from '../http-types'
import { removeItemFiles } from './files/remove'
import { oqItemState } from './open-rule'

export const COLLECTIONS = ['checks', 'items', 'work'] as const
export type Collection = (typeof COLLECTIONS)[number]
export type Scope = 'read' | 'agent' | 'owner'

export interface Actor {
  name: string
  scopes: Scope[]
}

export interface Doc {
  id: string
  data: Record<string, unknown>
  version: number
  updatedAt: number
}

export const DOC_ID = /^[A-Za-z0-9_.~:@+-]{1,80}$/
const MAX_DOC_BYTES = 48 * 1024
const OWNER_FIELDS = ['done', 'choice', 'note', 'at'] as const
const AGENT_STATUSES = ['taken', 'doing', 'blocked', 'done', 'planned'] as const

const httpsLink = z.object({ href: z.string().regex(/^https:\/\/[^\s"<>]+$/).max(2000), text: z.string().max(200).optional() })
// Входящее из Telegram (kind: 'inbox'): владелец переслал боту сообщение, бот уточнил тип и срочность кнопками.
// Ведёт агент-сессия: карточка Notion или фикс; протокол — docs/specs/owner-queue.md «Входящие из Telegram».
export const INBOX_TYPES = ['bug', 'idea', 'task', 'alert'] as const
export const INBOX_URGENCIES = ['now', 'queue'] as const
export const INBOX_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const INBOX_ORIGIN_KINDS = ['self', 'user', 'hidden', 'bot', 'chat', 'channel'] as const
const inboxSchema = z
  .object({
    type: z.enum(INBOX_TYPES),
    urgency: z.enum(INBOX_URGENCIES),
    severity: z.enum(INBOX_SEVERITIES).optional(),
    text: z.string().min(1).max(8000),
    // Подпись отправителя — для показа; доверять можно только originKind и forwarded (их ставит бот, не текст).
    origin: z.string().max(200).optional(),
    originKind: z.enum(INBOX_ORIGIN_KINDS),
    forwarded: z.boolean(),
    receivedAt: z.string().max(40),
    hasMedia: z.boolean().optional(),
    /** Сколько файлов создатель (бот, форма) собирается приложить: ready < expected — файлы ещё грузятся. */
    filesExpected: z.number().int().min(0).max(20).optional(),
    /** Файлы, которые не приняты, и почему — агент видит, а не гадает. */
    filesFailed: z.array(z.object({ name: z.string().max(200), reason: z.string().max(200) }).strict()).max(20).optional(),
  })
  .strict()
  .refine((d) => !d.severity || d.type === 'bug' || d.type === 'alert', { message: 'Важность (severity) — только у ошибки и алерта' })
// Формат пунктов — протокол «Для агентов» со страницы артефакта; лишние поля (pr, deploy и будущие) допускаются.
const itemSchema = z
  .object({
    kind: z.enum(['decision', 'merge', 'server', 'check', 'inbox']),
    title: z.string().min(1).max(300),
    body: z.string().max(12_000).optional(),
    after: z.string().max(12_000).optional(),
    cmd: z.string().max(8000).optional(),
    cmd2: z.string().max(8000).optional(),
    field: z.string().max(120).optional(),
    placeholder: z.string().max(120).optional(),
    // Подписи и подсказки хранятся целиком, страница сама обрезает при показе (label 120, hint 60, метка 40).
    options: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), label: z.string().max(300), hint: z.string().max(300).optional() })).max(5).optional(),
    chips: z.array(z.array(z.string().max(200)).min(1).max(2)).max(8).optional(),
    links: z.array(httpsLink).max(40).optional(),
    added: z.string().max(10).optional(),
    source: z.string().max(80).optional(),
    archived: z.boolean().optional(),
    pr: z.number().int().positive().optional(),
    deploy: z.enum(['deploy', 'skip', 'none']).optional(),
    // Вердикт «Контроля»: голова и база PR. Без обоих полей кнопка «Влить» неактивна (queue/github.ts). Только
    // полный SHA — короткий молча не засчитался бы.
    sha: z.string().regex(/^[0-9a-f]{40}$/, 'sha — полный SHA головы PR (40 символов hex), одобренной «Контролем»').optional(),
    base: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'base — ветка-база PR, для которой дан вердикт (например main)').optional(),
    inbox: inboxSchema.optional(),
  })
  .passthrough()
  .refine((d) => d.kind !== 'decision' || (d.options?.length ?? 0) > 0, { message: 'У решения должны быть варианты (options)' })
  .refine((d) => (d.kind === 'inbox') === (d.inbox !== undefined), { message: 'Поле inbox — у пункта kind: inbox, и только у него' })

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/).max(30)
// Документ work может быть частичной правкой задачи из базового плана страницы (WORK_SEED): страница
// накладывает его поверх по id, поэтому title и track необязательны.
const workSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    track: z.string().max(40).optional(),
    status: z.string().max(20).optional(),
    who: z.string().max(20).optional(),
    session: z.string().max(200).optional(),
    planStart: dateStr.optional(),
    planEnd: dateStr.optional(),
    basePlanEnd: dateStr.optional(),
    start: dateStr.optional(),
    end: dateStr.optional(),
    milestone: z.boolean().optional(),
    note: z.string().max(600).optional(),
    link: z.string().regex(/^https:\/\/[^\s"<>]+$/).max(2000).optional(),
    linkText: z.string().max(200).optional(),
    order: z.number().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough()

const checkSchema = z
  .object({
    done: z.boolean().optional(),
    choice: z.string().max(40).nullable().optional(),
    note: z.string().max(20_000).optional(),
    at: z.string().max(40).optional(),
    agentStatus: z.enum(AGENT_STATUSES).optional(),
    agentNote: z.string().max(2000).optional(),
    // Какая сессия ведёт пункт (для входящих — захват, см. authorize) и когда агент писал в последний раз:
    // agentAt ставит сервер, присланное агентом значение перезаписывается.
    agentBy: z.string().max(120).optional(),
    agentAt: z.string().max(40).optional(),
    // Серверные отметки (ревью «Контроля» #324, п. 4): когда сохранён ответ владельца и когда сессия перевела пункт
    // в blocked. Правило «ждёт вас снова» сравнивает их, а не часы устройства владельца с agentAt любой записи агента.
    ownerAt: z.string().max(40).optional(),
    blockedAt: z.string().max(40).optional(),
  })
  .strict()

/** Поля агента в checks: замена документа владельцем (PUT) их не стирает (ревью #324, п. 5). */
const AGENT_FIELDS = ['agentStatus', 'agentNote', 'agentBy', 'agentAt', 'blockedAt'] as const

const SCHEMAS: Record<Collection, z.ZodTypeAny> = { checks: checkSchema, items: itemSchema, work: workSchema }

export function isCollection(v: string): v is Collection {
  return (COLLECTIONS as readonly string[]).includes(v)
}

const has = (a: Actor, s: Scope) => a.scopes.includes('owner') || a.scopes.includes(s)

function parseDoc(row: typeof oqDocs.$inferSelect): Doc {
  return { id: row.id, data: JSON.parse(row.dataJson) as Record<string, unknown>, version: row.version, updatedAt: row.updatedAt.getTime() }
}

export async function listDocs(collection: Collection): Promise<Doc[]> {
  const rows = await getDb().select().from(oqDocs).where(eq(oqDocs.collection, collection)).orderBy(desc(oqDocs.updatedAt)).limit(2000)
  return rows.map(parseDoc)
}

/** ETag коллекции: меняется при любой записи — опрос страницы раз в несколько секунд стоит один дешёвый запрос. */
export async function collectionTag(collection: Collection): Promise<string> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)`, last: sql<number>`coalesce(max(${oqDocs.updatedAt}), 0)`, v: sql<number>`coalesce(sum(${oqDocs.version}), 0)` })
    .from(oqDocs)
    .where(eq(oqDocs.collection, collection))
  return `"${createHash('sha1').update(`${collection}:${row?.n}:${row?.last}:${row?.v}`).digest('hex').slice(0, 20)}"`
}

export async function getDoc(collection: Collection, id: string): Promise<Doc | null> {
  const row = await getDb().query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)) })
  return row ? parseDoc(row) : null
}

/** ETag ответа ?open=1: открытость пункта зависит от items и checks — тег меняется при записи в любую из них. */
export async function openItemsTag(): Promise<string> {
  const [items, checks] = await Promise.all([collectionTag('items'), collectionTag('checks')])
  return `"${createHash('sha1').update(`open:${items}:${checks}`).digest('hex').slice(0, 20)}"`
}

/** Пункты, открытые владельцу, — не archived и не закрытые по правилу страницы (open-rule.ts, «ждёт вас снова» — открыт). */
export async function listOpenItems(): Promise<Doc[]> {
  const items = (await listDocs('items')).filter((d) => d.data.archived !== true)
  // Ответы — по id этих пунктов, а не последние 2000 checks: при большем числе ответов старые выпадали, и отвеченный
  // пункт снова считался открытым (ревью «Контроля» #324, п. 9). Порциями по 500 id.
  const answers = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < items.length; i += 500) {
    const ids = items.slice(i, i + 500).map((d) => d.id)
    const rows = await getDb().select().from(oqDocs).where(and(eq(oqDocs.collection, 'checks'), inArray(oqDocs.id, ids)))
    for (const r of rows) answers.set(r.id, JSON.parse(r.dataJson) as Record<string, unknown>)
  }
  return items.filter((d) => oqItemState(d.data.kind, answers.get(d.id)) !== 'done')
}

/**
 * Серверные поля checks: agentAt — время последней записи агента (от него снимается захват, CLAIM_TTL_MS); ownerAt —
 * время сохранения ответа владельца; blockedAt — переход сессии в blocked. Присланные значения не принимаются.
 * Замена документа владельцем сохраняет поля агента: старые вкладки стирали бы захват и возвращали прежний статус.
 */
function stampCheck(
  merged: Record<string, unknown>,
  before: Record<string, unknown> | null,
  data: Record<string, unknown>,
  o: { owner: boolean; merge: boolean; at: string },
): void {
  for (const k of ['ownerAt', 'blockedAt'] as const) {
    if (before?.[k] !== undefined) merged[k] = before[k]
    else delete merged[k]
  }
  if (o.owner && !o.merge && before) {
    for (const k of AGENT_FIELDS) if (before[k] !== undefined && !(k in data)) merged[k] = before[k]
  }
  if (o.owner && (OWNER_FIELDS as readonly string[]).some((k) => k in data)) merged.ownerAt = o.at
  if (!o.owner) {
    merged.agentAt = o.at
    if (merged.agentStatus === 'blocked' && before?.agentStatus !== 'blocked') merged.blockedAt = o.at
  }
}

/** Что именно меняется — для проверки прав по полям. */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

const CLAIMED = ['taken', 'doing']
// Захват входящего, у которого сессия не писала 12 ч, снимается: сессия могла закончиться, не отпустив пункт.
export const CLAIM_TTL_MS = 12 * 3600_000

interface WriteContext {
  /** checks/<id> относится к входящему (items/<id> с kind: inbox) — на него действует захват сессией. */
  inbox: boolean
  now: number
}

function authorize(actor: Actor, collection: Collection, before: Record<string, unknown> | null, after: Record<string, unknown>, incoming: Record<string, unknown>, ctx: WriteContext): void {
  // Любая запись — только agent или owner: токен «только чтение» не создаёт и не трогает документы, даже пустой правкой.
  if (!has(actor, 'agent')) throw apiError(403, 'Нужна область agent')
  const owner = actor.scopes.includes('owner')
  if (collection === 'checks') {
    const changed = changedKeys(before ?? {}, after)
    const ownerChange = changed.some((k) => (OWNER_FIELDS as readonly string[]).includes(k))
    if (ownerChange && !owner) throw apiError(403, 'Ответ владельца (done, choice, note, at) меняет только владелец; агенту — agentStatus и agentNote')
    // Захват входящего сессией (кооперативный: имя присылает сама сессия — docs/specs/owner-queue.md). Пока пункт не
    // «сделано» и сессия писала в него за последние 12 ч, статус и заметку меняет только она — иначе другая сессия
    // сняла бы захват через planned/blocked/done и взяла пункт. Обычные пункты (d-/m-/s-/c-) сессии ведут совместно,
    // в том числе старым MCP без session: на них захват не действует.
    if (!owner && ctx.inbox) {
      const by = typeof incoming.agentBy === 'string' ? incoming.agentBy : ''
      const prevBy = typeof before?.agentBy === 'string' ? before.agentBy : ''
      const since = typeof before?.agentAt === 'string' ? Date.parse(before.agentAt) : Number.NaN
      const held = !!prevBy && !!before && before.agentStatus !== undefined && before.agentStatus !== 'done' && !(ctx.now - since > CLAIM_TTL_MS)
      if (held && by !== prevBy) {
        throw apiError(409, by
          ? `Пункт уже ведёт ${prevBy} — возьмите другой или договоритесь с этой сессией`
          : `Пункт ведёт ${prevBy}. Если это вы — передайте session (имя своей сессии)`)
      }
      if (!by && CLAIMED.includes(String(incoming.agentStatus))) {
        throw apiError(422, 'Входящее берут с session — имя своей сессии (oq_agent_status). Старый MCP без session: переподключите /mcp')
      }
    }
    return
  }
  // Входящее из Telegram создаёт и меняет только владелец (бот): иначе агент мог бы выдать свой текст за слова владельца.
  if (collection === 'items' && (after.kind === 'inbox' || before?.kind === 'inbox') && !owner) {
    throw apiError(403, 'Входящие (kind: inbox) пишет только владелец через бота; агенту — свой статус в checks (oq_agent_status)')
  }
  if (collection === 'work' && !actor.scopes.includes('owner') && before) {
    const prev = before.planEnd
    if (typeof prev === 'string' && after.planEnd !== prev && after.basePlanEnd !== prev && before.basePlanEnd === undefined) {
      throw apiError(409, `planEnd не переписывается: от него считается отставание. Сдвиг — новый planEnd и basePlanEnd = «${prev}», причина в note`)
    }
  }
}

export interface WriteOptions {
  /** true — слить с текущим документом (update), false — заменить (set). */
  merge: boolean
  ifVersion?: number
  /**
   * Ответ владельца в checks: `at` ответа, от которого начата правка ('' — ответа не было). Сохранён другой ответ —
   * 409, чтобы повтор старой правки (вкладка бота, заснувший телефон) не перезаписал новый (ревью #324, п. 1).
   */
  ifAnswerAt?: string
}

export async function writeDoc(actor: Actor, collection: Collection, id: string, data: Record<string, unknown>, opts: WriteOptions): Promise<Doc> {
  if (!DOC_ID.test(id)) throw apiError(422, 'Недопустимый id документа')
  const db = getDb()
  return db.transaction(async (tx) => {
    const row = await tx.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)) })
    const before = row ? (JSON.parse(row.dataJson) as Record<string, unknown>) : null
    if (opts.ifVersion !== undefined && (row?.version ?? 0) !== opts.ifVersion) {
      throw apiError(409, `Документ изменился (версия ${row?.version ?? 0}, у вас ${opts.ifVersion}) — перечитайте и повторите`)
    }
    const owner = actor.scopes.includes('owner')
    // Агент по checks — только слиянием своих полей: set затёр бы ответ владельца.
    if (collection === 'checks' && !opts.merge && !owner) throw apiError(403, 'Агенту по checks — только update полей agentStatus/agentNote')
    if (collection === 'checks' && owner && opts.ifAnswerAt !== undefined) {
      const stored = typeof before?.at === 'string' ? before.at : ''
      if (stored !== opts.ifAnswerAt) {
        throw apiError(409, 'Ответ уже изменён в другом месте (другая вкладка, телефон или бот) — показан сохранённый')
      }
    }
    const merged: Record<string, unknown> = opts.merge ? { ...(before ?? {}), ...data } : { ...data }
    for (const [k, v] of Object.entries(merged)) if (v === null && collection !== 'checks') delete merged[k]
    const at = new Date()
    if (collection === 'checks') stampCheck(merged, before, data, { owner, merge: opts.merge, at: at.toISOString() })
    // Входящее ли это — по пункту items/<id>: захват сессией действует только на входящие.
    const itemRow = collection === 'checks' && !owner
      ? await tx.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, id)) })
      : undefined
    const inbox = !!itemRow && (JSON.parse(itemRow.dataJson) as Record<string, unknown>).kind === 'inbox'
    const parsed = SCHEMAS[collection].safeParse(merged)
    if (!parsed.success) throw apiError(422, `Неверный документ: ${parsed.error.issues.map((i) => `${i.path.join('.') || '—'}: ${i.message}`).join('; ').slice(0, 400)}`)
    const json = JSON.stringify(parsed.data)
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw apiError(422, 'Документ больше 48 КБ')
    authorize(actor, collection, before, parsed.data as Record<string, unknown>, data, { inbox, now: at.getTime() })
    const version = (row?.version ?? 0) + 1
    if (row) {
      await tx.update(oqDocs).set({ dataJson: json, version, updatedAt: at, updatedBy: actor.name }).where(and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)))
    } else {
      await tx.insert(oqDocs).values({ collection, id, dataJson: json, version, createdAt: at, updatedAt: at, updatedBy: actor.name })
    }
    await tx.insert(oqEvents).values({ at, actor: actor.name, collection, docId: id, action: opts.merge ? 'update' : 'set', beforeJson: row?.dataJson ?? null, afterJson: json })
    return { id, data: parsed.data as Record<string, unknown>, version, updatedAt: at.getTime() }
  })
}

export async function deleteDoc(actor: Actor, collection: Collection, id: string): Promise<void> {
  if (!actor.scopes.includes('owner')) throw apiError(403, 'Удаляет только владелец; агенту — archived: true')
  const db = getDb()
  const row = await db.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)) })
  if (!row) throw apiError(404, 'Нет такого документа')
  await db.delete(oqDocs).where(and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)))
  await db.insert(oqEvents).values({ actor: actor.name, collection, docId: id, action: 'delete', beforeJson: row.dataJson })
  // Вложения удалённого пункта: строки — сразу, файлы — следом (уборщик — только подстраховка). Сбой диска здесь
  // не превращает уже выполненное удаление в 500: файлы подберёт уборка (линза GLM #313).
  if (collection === 'items') {
    await removeItemFiles(id).catch((e: unknown) => console.warn(`[oq-files] файлы удалённого пункта ${id} не убраны сразу: ${(e as Error)?.message ?? e}`))
  }
}

export async function logEvent(actor: string, collection: string, docId: string, action: string, after?: unknown): Promise<void> {
  await getDb().insert(oqEvents).values({ actor, collection, docId, action, afterJson: after === undefined ? null : JSON.stringify(after).slice(0, 20_000) })
}

export async function docHistory(collection: Collection, id: string, limit = 50) {
  const rows = await getDb()
    .select()
    .from(oqEvents)
    .where(and(eq(oqEvents.collection, collection), eq(oqEvents.docId, id)))
    .orderBy(desc(oqEvents.at))
    .limit(Math.min(limit, 100))
  return rows.map((r) => ({ at: r.at.getTime(), actor: r.actor, action: r.action, after: r.afterJson ? JSON.parse(r.afterJson) : null }))
}

/** Импорт выгрузки артефакта: документ кладётся как есть (версия 1), существующий не перезаписывается. */
export async function importDoc(collection: Collection, id: string, data: Record<string, unknown>, source: string): Promise<'added' | 'kept' | 'invalid'> {
  if (!DOC_ID.test(id)) return 'invalid'
  const parsed = SCHEMAS[collection].safeParse(data)
  if (!parsed.success) return 'invalid'
  const db = getDb()
  const exists = await db.query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, collection), eq(oqDocs.id, id)) })
  if (exists) return 'kept'
  const json = JSON.stringify(parsed.data)
  await db.insert(oqDocs).values({ collection, id, dataJson: json, version: 1, updatedBy: source })
  await db.insert(oqEvents).values({ actor: source, collection, docId: id, action: 'import', afterJson: json })
  return 'added'
}
