/** Метаданные вложений (`oq_files`). Сам файл — storage.ts; здесь — строки и правила лимитов. */
import { and, desc, eq, exists, isNull, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { oqDocs, oqFiles } from '../../db/schema'
import { oqWrite, type NewOqFile } from '../oq-write'
import { canSee, productWhere, type Visibility } from '../products'

/**
 * Счётчик изменений вложений в этом процессе (консоль — один процесс): входит в отпечаток сводки рядом с агрегатами
 * таблицы — те не различат «удалили самый новый и загрузили другой того же размера в ту же секунду».
 */
let epoch = 0
export const filesEpoch = (): number => epoch
const bump = (): void => { epoch++ }

export type FileRow = typeof oqFiles.$inferSelect
export type NewFileRow = NewOqFile

export type InsertResult =
  | { status: 'created' | 'duplicate'; row: FileRow }
  | { status: 'limit' }
  | { status: 'cap' }

/** Пункт items/<id>: его продукт и входящее ли это; нет пункта — null. */
export async function itemInfo(itemId: string): Promise<{ product: string; inbox: boolean } | null> {
  const row = await getDb().query.oqDocs.findFirst({ where: and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, itemId)) })
  if (!row) return null
  try {
    return { product: row.product, inbox: (JSON.parse(row.dataJson) as { kind?: unknown }).kind === 'inbox' }
  } catch {
    return { product: row.product, inbox: false }
  }
}

/** Пункт существует, это входящее (вложения бывают только у задач владельца) и он в видимых продуктах. */
export async function isInboxItem(itemId: string, products: Visibility): Promise<boolean> {
  const info = await itemInfo(itemId)
  return !!info && info.inbox && canSee(products, info.product)
}

/**
 * Вставка одним оператором (oq-write.ts, insertFileIfRoom): лимит на пункт и общий потолок проверяются в том же
 * `INSERT … SELECT`, что и вставка. Идущие загрузки сюда не входят: иначе две параллельные у потолка отказали бы обе.
 * Тот же файл в том же пункте — прежняя строка (повтор доставки ботом, двойное нажатие).
 */
export async function insertFile(row: NewFileRow, opts: { maxPerItem: number; capBytes: number }): Promise<InsertResult> {
  // Отказ объясняется по снимку той же транзакции: между вставкой и проверкой место никто не освободит (записи идут по
  // одной), поэтому прежний повтор вставки здесь не нужен.
  const res = await oqWrite(async (w): Promise<InsertResult> => {
    if (await w.insertFileIfRoom(row, opts)) {
      const created = await w.tx.query.oqFiles.findFirst({ where: eq(oqFiles.id, row.id) })
      return { status: 'created', row: created! }
    }
    const dup = await w.tx.query.oqFiles.findFirst({
      where: and(eq(oqFiles.itemId, row.itemId), eq(oqFiles.sha256, row.sha256), isNull(oqFiles.deletedAt)),
    })
    if (dup) return { status: 'duplicate', row: dup }
    // Не дубль и не вставлено — значит, мешает лимит пункта или общий потолок (лимит — первым, как и раньше).
    const snap = await w.tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM oq_files WHERE item_id = ${row.itemId} AND deleted_at IS NULL`)
    return Number(snap?.n ?? 0) >= opts.maxPerItem ? { status: 'limit' } : { status: 'cap' }
  })
  if (res.status === 'created') bump()
  return res
}

/**
 * Живые файлы пункта и сколько удалено по сроку. Отдельными запросами: надгробия копятся без очистки, и общий
 * LIMIT по всем строкам вытеснил бы из списка живые файлы (линза GLM #313).
 */
export async function listItemFiles(itemId: string): Promise<{ files: FileRow[]; expired: number }> {
  const db = getDb()
  // Порядок загрузки: при равной метке времени (миллисекунды, параллельные загрузки) решает порядок вставки (rowid). Живых в пункте — не больше
  // лимита (до 20), 50 — с запасом.
  const files = await db.select().from(oqFiles).where(and(eq(oqFiles.itemId, itemId), isNull(oqFiles.deletedAt))).orderBy(oqFiles.createdAt, sql`rowid`).limit(50)
  const [tombs] = await db
    .select({ n: sql<number>`count(*)` })
    .from(oqFiles)
    .where(and(eq(oqFiles.itemId, itemId), eq(oqFiles.deletedReason, 'retention')))
  return { files, expired: Number(tombs?.n ?? 0) }
}

/** Пунктов с вложениями в сводке — с запасом: пункты не удаляются, надгробия копятся (см. журнал при обрезке). */
export const SUMMARY_ITEMS_MAX = 5000

export interface FilesSummary {
  /** Живые файлы, новые первыми: не больше `limit` строк. */
  files: FileRow[]
  /** Живых файлов у пункта — по всем пунктам: карточка, чьи файлы не вошли в `files`, знает, что их надо догрузить. */
  counts: Map<string, number>
  /** Удалено по сроку — надгробия по пунктам. */
  expired: Map<string, number>
  /** Что урезано: строки файлов (`files`) или сами списки пунктов (`groups`). */
  truncated: { files: boolean; groups: boolean }
}

/**
 * Вложения всех входящих — для страницы /queue: строки файлов только у новых (до `limit`), а число живых файлов и
 * надгробий — у всех пунктов. Так ответ ограничен, а старый пункт не теряет вложения молча: страница видит счётчик
 * и догружает список пункта по `GET /files?item=`.
 */
export async function listAllFiles(products: Visibility, limit = 300): Promise<FilesSummary> {
  const db = getDb()
  // Файлы только пунктов видимых продуктов: подзапрос по items, у владельца — без условия.
  // EXISTS по первичному ключу пункта — стоимость от числа файлов, а не пунктов продукта (IN-подзапрос строил список
  // всех пунктов трижды на сводку).
  const own = products === '*' ? undefined : exists(db.select({ x: sql`1` }).from(oqDocs).where(and(eq(oqDocs.collection, 'items'), eq(oqDocs.id, oqFiles.itemId), productWhere(products))))
  const rows = await db.select().from(oqFiles).where(and(isNull(oqFiles.deletedAt), own)).orderBy(desc(oqFiles.createdAt), sql`rowid desc`).limit(limit + 1)
  const groups = (where: SQL) =>
    db.select({ itemId: oqFiles.itemId, n: sql<number>`count(*)` }).from(oqFiles).where(and(where, own)).groupBy(oqFiles.itemId).limit(SUMMARY_ITEMS_MAX + 1)
  const [live, tombs] = await Promise.all([groups(isNull(oqFiles.deletedAt)), groups(eq(oqFiles.deletedReason, 'retention'))])
  const toMap = (list: { itemId: string; n: number }[]) => new Map(list.slice(0, SUMMARY_ITEMS_MAX).map((t) => [t.itemId, Number(t.n)]))
  return {
    files: rows.slice(0, limit),
    counts: toMap(live),
    expired: toMap(tombs),
    truncated: { files: rows.length > limit, groups: live.length > SUMMARY_ITEMS_MAX || tombs.length > SUMMARY_ITEMS_MAX },
  }
}

/** Имя, не повторяющее живые файлы пункта: «отчёт.pdf», «отчёт (2).pdf». */
export async function uniqueNameInItem(itemId: string, name: string): Promise<string> {
  const taken = new Set(
    (await getDb().select({ name: oqFiles.name }).from(oqFiles).where(and(eq(oqFiles.itemId, itemId), isNull(oqFiles.deletedAt))).limit(50)).map(
      (r) => r.name,
    ),
  )
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 2; i < 100; i++) {
    const next = `${base} (${i})${ext}`
    if (!taken.has(next)) return next
  }
  return name
}

/**
 * Записи уборки — порциями: одна пачка истёкших по сроку или старых надгробий не должна упереться в предел числа
 * параметров SQLite и уронить всю уборку (линза GLM #313).
 */
const WRITE_CHUNK = 500
const chunks = (ids: string[]): string[][] => Array.from({ length: Math.ceil(ids.length / WRITE_CHUNK) }, (_, i) => ids.slice(i * WRITE_CHUNK, (i + 1) * WRITE_CHUNK))

/** Срок хранения истёк: файл удаляется, строка остаётся надгробием. */
export async function markExpired(ids: string[], at: Date): Promise<void> {
  if (!ids.length) return
  for (const part of chunks(ids)) await oqWrite((w) => w.expireFiles(part, at))
  bump()
}

export async function getFile(id: string): Promise<FileRow | null> {
  return (await getDb().query.oqFiles.findFirst({ where: eq(oqFiles.id, id) })) ?? null
}

export async function deleteFileRow(id: string): Promise<boolean> {
  const res = await oqWrite((w) => w.deleteFiles({ ids: [id] }))
  if (res.length) bump()
  return res.length > 0
}

/** Строки вложений пункта удаляются; возвращает id — их файлы удаляет вызывающий после коммита. */
export async function deleteItemFileRows(itemId: string): Promise<string[]> {
  const res = await oqWrite((w) => w.deleteFiles({ itemId }))
  if (res.length) bump()
  return res
}

/** Отпечаток таблицы вложений одним проходом: меняется при любой вставке, удалении и надгробии. */
export async function filesFingerprint(): Promise<[number, number, number, number]> {
  const r = await getDb().get<{ n: number; total: number; c: number; d: number }>(sql`
    SELECT count(*) AS n, coalesce(sum(size), 0) AS total, coalesce(max(created_at), 0) AS c, coalesce(max(deleted_at), 0) AS d FROM oq_files`)
  return [Number(r?.n ?? 0), Number(r?.total ?? 0), Number(r?.c ?? 0), Number(r?.d ?? 0)]
}

export async function usedBytes(): Promise<number> {
  const [summed] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${oqFiles.size}), 0)` })
    .from(oqFiles)
    .where(isNull(oqFiles.deletedAt))
  return Number(summed?.total ?? 0)
}

/** Для уборки: все строки (их немного — потолок файлов на пункт, срок 90 дней), страницами по 500. */
export async function allFileRows(afterId = ''): Promise<FileRow[]> {
  return getDb().select().from(oqFiles).where(sql`${oqFiles.id} > ${afterId}`).orderBy(oqFiles.id).limit(500)
}

export async function deleteRows(ids: string[]): Promise<void> {
  if (!ids.length) return
  for (const part of chunks(ids)) await oqWrite((w) => w.deleteFiles({ ids: part }))
  bump()
}

