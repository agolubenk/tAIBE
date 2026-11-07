/**
 * Списки очереди и их ETag — по видимости актора (продукты, queue/products.ts): токен продукта A не получает документы
 * продукта B ни в списке, ни в ?open=1, а тег не меняется от записей в чужом продукте.
 */
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { oqDocs } from '../db/schema'
import { oqItemState } from './open-rule'
import { productWhere, visibilityKey, type Visibility } from './products'
import { parseDoc, type Collection, type Doc } from './store'

/**
 * Потолок списка коллекции — по числу документов и по объёму, видимый: `capped` → в ответе API `truncated`, `total`,
 * `limit` (прежний limit(2000) обрезал молча, и обрезанные checks сделали бы отвеченные пункты снова открытыми).
 * Объём — сумма data_json самых свежих: документ до 48 КБ, и 10 000 таких — около 470 МБ JSON на сборку, а сборка
 * занимает в памяти ещё в несколько раз больше (лимит консоли 512 МБ). Убирает потолок /changes.
 */
const LIST_LIMITS_DEFAULT = { max: 10_000, bytes: 16 * 1024 * 1024 }
let listLimits = LIST_LIMITS_DEFAULT

/** Только для тестов: маленький потолок вместо 10 000 документов в фикстуре. null — вернуть обычный. */
export function setListLimitsForTests(v: Partial<typeof LIST_LIMITS_DEFAULT> | null): void {
  listLimits = { ...LIST_LIMITS_DEFAULT, ...v }
}

/**
 * capped — список обрезан потолком: total — сколько видимых документов в коллекции, limit — сколько самых свежих
 * прочитано. У listOpenItems docs — открытые среди этих limit, поэтому docs.length может быть меньше limit.
 */
export type DocList = { docs: Doc[]; capped?: { total: number; limit: number } }

const visible = (collection: Collection, products: Visibility) => and(eq(oqDocs.collection, collection), productWhere(products))

export async function listDocs(collection: Collection, products: Visibility): Promise<DocList> {
  const { max, bytes } = listLimits
  // Накопленный объём от самых свежих и размер коллекции — окном по узкому подзапросу (id и числа, без тел), одним
  // запросом: тела читаются только у документов в пределах потолка, total согласован с выборкой.
  const w = getDb()
    .select({
      id: oqDocs.id,
      run: sql<number>`sum(length(cast(${oqDocs.dataJson} as blob))) over (order by ${oqDocs.updatedAt} desc rows unbounded preceding)`.as('run'),
      total: sql<number>`count(*) over ()`.as('total'),
    })
    .from(oqDocs)
    .where(visible(collection, products))
    .as('w')
  const rows = await getDb()
    .select({ doc: oqDocs, total: w.total })
    .from(oqDocs)
    .innerJoin(w, and(eq(oqDocs.collection, collection), eq(oqDocs.id, w.id)))
    .where(lte(w.run, bytes))
    .orderBy(desc(oqDocs.updatedAt))
    .limit(max)
  const docs = rows.map((r) => parseDoc(r.doc))
  // Пусто, а коллекция нет — самый свежий документ больше потолка объёма: total — отдельным count.
  const total = rows.length ? Number(rows[0]!.total) : Number((await collectionStats(collection, products)).n)
  return total > docs.length ? { docs, capped: { total, limit: docs.length } } : { docs }
}

async function collectionStats(collection: Collection, products: Visibility) {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)`, last: sql<number>`coalesce(max(${oqDocs.updatedAt}), 0)`, v: sql<number>`coalesce(sum(${oqDocs.version}), 0)` })
    .from(oqDocs)
    .where(visible(collection, products))
  return { n: row?.n ?? 0, last: row?.last ?? 0, v: row?.v ?? 0 }
}

/**
 * ETag коллекции в видимости актора: меняется при любой записи в видимые продукты. Слабый — один у gzip и несжатого
 * ответа. Потолок и видимость — в теге: после смены потолка клиент со списком, обрезанным прежним, получит 200, а не 304.
 */
export async function collectionTag(collection: Collection, products: Visibility): Promise<string> {
  const { n, last, v } = await collectionStats(collection, products)
  const key = `${collection}:${visibilityKey(products)}:${listLimits.max}:${listLimits.bytes}:${n}:${last}:${v}`
  return `W/"${createHash('sha1').update(key).digest('hex').slice(0, 20)}"`
}

/** ETag ответа ?open=1: открытость пункта зависит от items и checks — тег меняется при записи в любую из них. */
export async function openItemsTag(products: Visibility): Promise<string> {
  const [items, checks] = await Promise.all([collectionTag('items', products), collectionTag('checks', products)])
  return `W/"${createHash('sha1').update(`open:${items}:${checks}`).digest('hex').slice(0, 20)}"`
}

/** Пункты, открытые владельцу, — не archived и не закрытые по правилу страницы (open-rule.ts, «ждёт вас снова» — открыт). */
export async function listOpenItems(products: Visibility): Promise<DocList> {
  const { docs, capped } = await listDocs('items', products)
  const items = docs.filter((d) => d.data.archived !== true)
  // Ответы — по id этих пунктов, а не последние 2000 checks: при большем числе ответов старые выпадали, и отвеченный
  // пункт снова считался открытым (ревью «Контроля» #324, п. 9). Порциями по 500 id. checks/<id> — продукта items/<id>.
  const answers = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < items.length; i += 500) {
    const ids = items.slice(i, i + 500).map((d) => d.id)
    const rows = await getDb().select().from(oqDocs).where(and(eq(oqDocs.collection, 'checks'), inArray(oqDocs.id, ids)))
    for (const r of rows) answers.set(r.id, JSON.parse(r.dataJson) as Record<string, unknown>)
  }
  const open = items.filter((d) => oqItemState(d.data.kind, answers.get(d.id)) !== 'done')
  return capped ? { docs: open, capped } : { docs: open }
}
