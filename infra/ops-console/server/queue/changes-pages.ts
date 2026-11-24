/**
 * Полный список /changes по страницам (OPS-22): `?paged=1` — первая страница, `?page=<next>` — следующая. Склеенные
 * страницы дают тот же полный список, что прежний ответ без `since` (тот же потолок коллекции, list.ts), но каждый ответ
 * — не больше PAGE_LIMITS: клиент на медленной сети не ждёт десятки мегабайт одним телом, сервер не держит весь список
 * в памяти.
 *
 * Курсор журнала берётся на первой странице до документов (как listsWithCursor) и один на все страницы. Запись между
 * страницами переносит документ наверх порядка (updated_at desc), и страница его может пропустить, — но событие этой
 * записи новее курсора, и первая дельта после последней страницы его вернёт. Повтор документа идемпотентен.
 *
 * Токен страницы — позиция, не секрет: base64url JSON с меткой запуска, курсором, коллекциями и ключом (updated_at, id)
 * последнего отданного документа. Видимость продуктов берётся из токена доступа каждого запроса; хэш видимости в
 * токене страницы только ловит смену ?product между страницами (400), а не разрешает что-либо.
 */
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { oqDocs } from '../db/schema'
import { apiError } from '../http-types'
import { BOOT, cursorOf, eventCursor, type Resync } from './changes'
import { collectionCount, listLimitsNow, type DocList } from './list'
import { productWhere, visibilityKey, type Visibility } from './products'
import { COLLECTIONS, DOC_ID, parseDoc, type Collection, type Doc } from './store'

/**
 * Потолок одной страницы: документов и объёма data_json. 1 МБ — около 8 с на 3G (1 Мбит/с) до сжатия, gzip ужимает
 * JSON очереди в 4–6 раз. Документ больше потолка объёма (до 48 КБ, store.ts) идёт отдельной страницей.
 */
const PAGE_LIMITS_DEFAULT = { docs: 1000, bytes: 1024 * 1024 }
let pageLimits = PAGE_LIMITS_DEFAULT

/** Только для тестов: маленькие страницы. null — вернуть обычные. */
export function setPageLimitsForTests(v: Partial<typeof PAGE_LIMITS_DEFAULT> | null): void {
  pageLimits = { ...PAGE_LIMITS_DEFAULT, ...v }
}

/** Длина токена: метка, курсор, три коллекции и id до 80 символов — около 340 символов base64url. */
export const PAGE_TOKEN_MAX = 512
const BAD_TOKEN = 'page — токен next из прошлого ответа /changes'

const tokenSchema = z
  .object({
    v: z.literal(1),
    boot: z.string().regex(/^[0-9a-z]{1,12}$/),
    cur: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    vis: z.string().regex(/^[0-9a-f]{12}$/),
    cols: z.array(z.enum(COLLECTIONS)).min(1).max(COLLECTIONS.length),
    col: z.enum(COLLECTIONS),
    u: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    id: z.string().regex(DOC_ID).nullable(),
    sent: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    b: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine((t) => (t.u === null) === (t.id === null), 'u и id — оба или ни одного')
  .refine((t) => t.cols.includes(t.col), 'col — из cols')

/** Позиция чтения: col — коллекция, (u, id) — ключ последнего отданного документа, sent/b — отдано в ней всего. */
type PageState = z.infer<typeof tokenSchema>
export type Page = { cursor: string; lists: Partial<Record<Collection, DocList>>; next?: string }

const visHash = (products: Visibility) => createHash('sha1').update(visibilityKey(products)).digest('hex').slice(0, 12)
const encode = (s: PageState) => Buffer.from(JSON.stringify(s), 'utf8').toString('base64url')

function decode(raw: string, cols: readonly Collection[], products: Visibility): PageState {
  if (raw.length === 0 || raw.length > PAGE_TOKEN_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) throw apiError(400, BAD_TOKEN)
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw apiError(400, BAD_TOKEN)
  }
  const parsed = tokenSchema.safeParse(json)
  if (!parsed.success) throw apiError(400, BAD_TOKEN)
  const s = parsed.data
  if (s.cols.join(',') !== cols.join(',')) throw apiError(400, 'page — от другого набора коллекций: ?col как на первой странице')
  if (s.vis !== visHash(products)) throw apiError(400, 'page — от другой видимости: ?product как на первой странице')
  return s
}

/**
 * Ключи документов коллекции после позиции, от самых свежих: id, updated_at как число и объём data_json — без тел.
 * Условие `updated_at <= u` даёт диапазон по индексу (collection, updated_at), остальное отсекает равные до id.
 * Экспорт — для теста плана запроса (EXPLAIN QUERY PLAN без SCAN).
 */
export function keysAfter(col: Collection, products: Visibility, u: number | null, id: string | null, limit: number) {
  const after = u === null ? undefined : sql`${oqDocs.updatedAt} <= ${u} and (${oqDocs.updatedAt} < ${u} or ${oqDocs.id} < ${id})`
  return getDb()
    .select({
      id: oqDocs.id,
      u: sql<number>`${oqDocs.updatedAt}`.mapWith(Number),
      len: sql<number>`length(cast(${oqDocs.dataJson} as blob))`.mapWith(Number),
    })
    .from(oqDocs)
    .where(and(eq(oqDocs.collection, col), productWhere(products), after))
    .orderBy(desc(oqDocs.updatedAt), desc(oqDocs.id))
    .limit(limit)
}

/** Тела по id в порядке ключей. Документ, удалённый между запросами, пропускается: его вернёт дельта от курсора. */
async function bodies(col: Collection, products: Visibility, ids: string[]): Promise<Doc[]> {
  const byId = new Map<string, Doc>()
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500)
    const rows = await getDb().select().from(oqDocs).where(and(eq(oqDocs.collection, col), inArray(oqDocs.id, part), productWhere(products)))
    for (const r of rows) byId.set(r.id, parseDoc(r))
  }
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/**
 * Страница полного списка. Без токена — первая: курсор журнала сейчас. Токен другого запуска консоли или новее журнала
 * — resync (410), как у дельты. Потолок коллекции (list.ts) проверяется раньше потолка страницы: коллекция кончается
 * на том же документе, что прежний полный список, и `truncated` приходит на странице, где она кончилась.
 */
export async function changesPage(cols: readonly Collection[], products: Visibility, rawToken?: string): Promise<Page | Resync> {
  let s: PageState
  if (rawToken === undefined) {
    s = { v: 1, boot: BOOT, cur: await eventCursor(), vis: visHash(products), cols: [...cols], col: cols[0]!, u: null, id: null, sent: 0, b: 0 }
  } else {
    s = decode(rawToken, cols, products)
    if (s.boot !== BOOT) return { resync: 'консоль перезапущена между страницами (миграции, восстановление базы) — начните с первой' }
    if (s.cur > (await eventCursor())) return { resync: 'курсор страницы новее журнала — база сменилась, начните с первой' }
  }
  const cap = listLimitsNow()
  const lists: Page['lists'] = {}
  let pageDocs = 0
  let pageBytes = 0
  for (let i = cols.indexOf(s.col); i < cols.length; i++) {
    const col = cols[i]!
    const pos = col === s.col ? { u: s.u, id: s.id, sent: s.sent, b: s.b } : { u: null as number | null, id: null as string | null, sent: 0, b: 0 }
    // +1 строка: увидеть, что за последней взятой есть ещё, — и решить, потолок это коллекции или конец страницы.
    const rows = await keysAfter(col, products, pos.u, pos.id, Math.max(0, Math.min(pageLimits.docs - pageDocs, cap.max - pos.sent)) + 1)
    const take: string[] = []
    let stop: 'cap' | 'page' | null = null
    for (const r of rows) {
      if (pos.sent >= cap.max || pos.b + r.len > cap.bytes) {
        stop = 'cap'
        break
      }
      if (pageDocs >= pageLimits.docs || (pageDocs > 0 && pageBytes + r.len > pageLimits.bytes)) {
        stop = 'page'
        break
      }
      take.push(r.id)
      pos.u = r.u
      pos.id = r.id
      pos.sent += 1
      pos.b += r.len
      pageDocs += 1
      pageBytes += r.len
    }
    const docs = await bodies(col, products, take)
    if (stop === 'page') {
      // Коллекция в ответе — только если на странице есть её документы или она здесь кончилась.
      if (docs.length) lists[col] = { docs }
      return { cursor: cursorOf(s.cur), lists, next: encode({ ...s, col, ...pos }) }
    }
    // Потолок: за последней взятой есть документ, значит total > sent. total — счёт сейчас, как у listDocs.
    lists[col] = stop === 'cap' ? { docs, capped: { total: await collectionCount(col, products), limit: pos.sent } } : { docs }
  }
  return { cursor: cursorOf(s.cur), lists }
}
