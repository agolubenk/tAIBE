/**
 * Дельта очереди (OPS-50; план — docs/plans/roadmap/owner-queue-multi-product.md, «Дельта вместо полной коллекции»):
 * опросчик (Нерв) получает только изменённые документы, а не всю коллекцию на каждую запись. Курсор — id журнала
 * oq_events: каждая запись документа пишет событие в той же транзакции (queue/store.ts, queue/product-change.ts),
 * журнал не чистится. Прежний список GET /db/:col не меняется.
 *
 * Порядок чтения: сначала курсор, потом документы. Запись между ними попадёт и в этот ответ, и в следующую дельту —
 * повтор идемпотентен (документ заменяется целиком, удалённый id удаляется ещё раз). SQLite пишет одной транзакцией за
 * раз, поэтому событие с меньшим id не появится в журнале позже события с большим.
 */
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqDocs, oqEvents } from '../db/schema'
import { listDocs, type DocList } from './list'
import { DEFAULT_PRODUCT, productWhere, type Visibility } from './products'
import { parseDoc, type Collection, type Doc } from './store'

/**
 * Курсор — «<запуск процесса>.<id события>»; клиент его не разбирает, а только возвращает. Метка запуска: миграции
 * (0014, 0016) и восстановление базы меняют oq_docs без событий журнала и идут при запуске консоли — после
 * перезапуска старый курсор даёт 410, клиент берёт полный список один раз. Консоль — один процесс на базу SQLite; два
 * процесса за балансировщиком давали бы 410 через раз (тогда метку — из базы).
 */
const BOOT = Date.now().toString(36)
export const CURSOR = /^[0-9a-z]{1,12}\.\d{1,15}$/
const cursorOf = (id: number) => `${BOOT}.${id}`

/**
 * Потолки дельты: изменённых документов (по всем запрошенным коллекциям) и событий журнала после курсора. Больше —
 * 410, клиент берёт полный список: он дешевле дельты почти на всю коллекцию, а сервер не сканирует журнал целиком.
 */
const CHANGES_LIMITS_DEFAULT = { docs: 500, events: 20_000 }
let changesLimits = CHANGES_LIMITS_DEFAULT

/** Только для тестов: маленькие потолки. null — вернуть обычные. */
export function setChangesLimitsForTests(v: Partial<typeof CHANGES_LIMITS_DEFAULT> | null): void {
  changesLimits = { ...CHANGES_LIMITS_DEFAULT, ...v }
}

export type CollectionChanges = { docs: Doc[]; removed: string[] }
export type Changes = { cursor: string; changes: Partial<Record<Collection, CollectionChanges>> }
/** Курсор не годится — причина для ответа 410. */
export type Resync = { resync: string }

/**
 * Последнее событие журнала (все коллекции и продукты); пустой журнал — 0. Входит и в тег кэша полного списка
 * (routes/queue.ts): иначе после 20 000 событий чужих продуктов кэш отдавал бы прежний курсор, а дельта от него — 410
 * по кругу (линза Контроля #623).
 */
export async function eventCursor(): Promise<number> {
  const [row] = await getDb().select({ id: sql<number>`coalesce(max(${oqEvents.id}), 0)` }).from(oqEvents)
  return Number(row?.id ?? 0)
}

/** Полные списки коллекций с курсором, с которого клиент начнёт дельты. Курсор — до документов (см. шапку). */
export async function listsWithCursor(cols: readonly Collection[], products: Visibility): Promise<{ cursor: string; lists: Partial<Record<Collection, DocList>> }> {
  const cursor = cursorOf(await eventCursor())
  const lists: Partial<Record<Collection, DocList>> = {}
  for (const col of cols) lists[col] = await listDocs(col, products)
  return { cursor, lists }
}

/**
 * Изменения коллекций после курсора в видимости актора: docs — изменённые и новые документы целиком, removed — id
 * удалённых и ушедших в невидимый продукт. События берутся только видимых продуктов (у события старого образа продукта
 * нет — это HR): id документа чужого продукта в ответ не попадает. Смена продукта пишет событие в обоих продуктах,
 * поэтому прежний продукт видит уход пункта как removed, новый — как новый документ.
 */
export async function changesSince(cols: readonly Collection[], products: Visibility, cursor: string): Promise<Changes | Resync> {
  const [boot, raw] = cursor.split('.')
  if (boot !== BOOT) return { resync: 'консоль перезапущена после курсора (миграции, восстановление базы) — нужен полный список' }
  const since = Number(raw)
  const cur = await eventCursor()
  if (since > cur) return { resync: 'курсор новее журнала — база сменилась, нужен полный список' }
  if (cur - since > changesLimits.events) return { resync: `после курсора больше ${changesLimits.events} событий журнала` }
  const changes: Changes['changes'] = {}
  for (const col of cols) changes[col] = { docs: [], removed: [] }
  if (products !== '*' && products.length === 0) return { cursor: cursorOf(cur), changes }
  const own = products === '*' ? undefined : inArray(sql`coalesce(${oqEvents.product}, ${DEFAULT_PRODUCT})`, [...products])
  const rows = await getDb()
    .selectDistinct({ col: oqEvents.collection, id: oqEvents.docId })
    .from(oqEvents)
    .where(and(gt(oqEvents.id, since), lte(oqEvents.id, cur), inArray(oqEvents.collection, [...cols]), own))
    .limit(changesLimits.docs + 1)
  if (rows.length > changesLimits.docs) return { resync: `после курсора изменено больше ${changesLimits.docs} документов` }
  for (const col of cols) {
    const ids = rows.filter((r) => r.col === col).map((r) => r.id)
    if (!ids.length) continue
    const docs = (await getDb().select().from(oqDocs).where(and(eq(oqDocs.collection, col), inArray(oqDocs.id, ids), productWhere(products)))).map(parseDoc)
    const present = new Set(docs.map((d) => d.id))
    changes[col] = { docs, removed: ids.filter((id) => !present.has(id)) }
  }
  return { cursor: cursorOf(cur), changes }
}
