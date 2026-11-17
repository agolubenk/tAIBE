/**
 * Один путь записи очереди владельца (TB-153, docs/specs/owner-queue-move.md §5.3 п. 1): всё, что пишет в oq_docs,
 * oq_events и oq_files, идёт через oqWrite — одна транзакция и одно время на неё. Время и все значения, которые схема
 * держит как DEFAULT, ставит этот модуль: после переезда в Postgres (шаги 2–4 спеки) два хранилища должны получить
 * одинаковые строки, а DEFAULT каждой БД дал бы своё время. Сюда же встанут блокировка Postgres и зеркало.
 * Запись в эти таблицы мимо модуля ловит tests/queue-one-writer.test.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb, type OpsDb } from '../db/client'
import { oqDocs, oqEvents, oqFiles } from '../db/schema'

export type OqTx = Parameters<Parameters<OpsDb['transaction']>[0]>[0]
export type OqDocRow = typeof oqDocs.$inferSelect
/** Строка документа без времени: createdAt и updatedAt ставит путь записи. */
export type NewOqDoc = Pick<OqDocRow, 'collection' | 'id' | 'dataJson' | 'version' | 'updatedBy' | 'product'>
export type DocUpdate = Pick<OqDocRow, 'version' | 'updatedBy'> & Partial<Pick<OqDocRow, 'dataJson' | 'product'>>
export interface OqEvent {
  actor: string
  collection: string
  docId: string
  action: string
  beforeJson?: string | null
  afterJson?: string | null
  /** null — событие не документа (деплой); история читает NULL как продукт по умолчанию. */
  product: string | null
}
/** Строка вложения без времени и надгробия: created_at ставит путь записи. */
export type NewOqFile = Omit<typeof oqFiles.$inferInsert, 'createdAt' | 'deletedAt' | 'deletedReason'>

export interface OqWriter {
  /** Одно время на транзакцию: документ, его событие и вложение получают одну метку. */
  readonly now: Date
  /** Чтения внутри транзакции (снаружи они не видят её записей). Запись — только методами ниже. */
  readonly tx: OqTx
  doc(collection: string, id: string): Promise<OqDocRow | undefined>
  insertDoc(row: NewOqDoc): Promise<void>
  updateDoc(collection: string, id: string, set: DocUpdate): Promise<void>
  deleteDoc(collection: string, id: string): Promise<void>
  event(...events: OqEvent[]): Promise<void>
  /** Вставка вложения, если пункт и общий потолок вмещают его, и такого файла в пункте ещё нет; true — вставлено. */
  insertFileIfRoom(row: NewOqFile, limits: { maxPerItem: number; capBytes: number }): Promise<boolean>
  /** Надгробие по сроку хранения. Время — у уборки: она решает, когда истёк срок (тесты подставляют своё). */
  expireFiles(ids: string[], at: Date): Promise<void>
  /** Удаляет строки вложений; возвращает их id — файлы на диске удаляет вызывающий после коммита. */
  deleteFiles(where: { ids: string[] } | { itemId: string }): Promise<string[]>
}

const docKey = (collection: string, id: string) => and(eq(oqDocs.collection, collection), eq(oqDocs.id, id))

function writer(tx: OqTx, now: Date): OqWriter {
  return {
    now,
    tx,
    doc: (collection, id) => tx.query.oqDocs.findFirst({ where: docKey(collection, id) }),
    async insertDoc(row) {
      await tx.insert(oqDocs).values({ ...row, createdAt: now, updatedAt: now })
    },
    async updateDoc(collection, id, set) {
      await tx
        .update(oqDocs)
        .set({ ...set, updatedAt: now })
        .where(docKey(collection, id))
    },
    async deleteDoc(collection, id) {
      await tx.delete(oqDocs).where(docKey(collection, id))
    },
    async event(...events) {
      if (!events.length) return
      await tx
        .insert(oqEvents)
        .values(events.map((e) => ({ ...e, at: now, beforeJson: e.beforeJson ?? null, afterJson: e.afterJson ?? null })))
    },
    async insertFileIfRoom(row, limits) {
      // Лимит на пункт и общий потолок — в том же INSERT … SELECT, что и вставка (линза GLM #313): проверка и запись не
      // расходятся. Тот же файл в том же пункте — DO NOTHING, вызывающий вернёт прежнюю строку.
      const res = await tx.run(sql`
        INSERT INTO oq_files (id, item_id, name, kind, mime, size, sha256, created_at, created_by)
        SELECT ${row.id}, ${row.itemId}, ${row.name}, ${row.kind}, ${row.mime}, ${row.size}, ${row.sha256}, ${now.getTime()}, ${row.createdBy}
        WHERE (SELECT count(*) FROM oq_files WHERE item_id = ${row.itemId} AND deleted_at IS NULL) < ${limits.maxPerItem}
          AND (SELECT coalesce(sum(size), 0) FROM oq_files WHERE deleted_at IS NULL) + ${row.size} <= ${limits.capBytes}
        ON CONFLICT (item_id, sha256) WHERE deleted_at IS NULL DO NOTHING`)
      return res.rowsAffected > 0
    },
    async expireFiles(ids, at) {
      if (!ids.length) return
      await tx.update(oqFiles).set({ deletedAt: at, deletedReason: 'retention' }).where(inArray(oqFiles.id, ids))
    },
    async deleteFiles(where) {
      if ('ids' in where && !where.ids.length) return []
      const cond = 'ids' in where ? inArray(oqFiles.id, where.ids) : eq(oqFiles.itemId, where.itemId)
      const res = await tx.delete(oqFiles).where(cond).returning({ id: oqFiles.id })
      return res.map((r) => r.id)
    },
  }
}

/**
 * Единственная пишущая транзакция очереди. Время берётся уже внутри транзакции, то есть после шлюза записи
 * (db/write-gate.ts), а не до ожидания в нём. Внутри fn читать через w.tx или w.doc: чтение через getDb() не видит
 * записей этой транзакции, а запись через getDb() ждала бы шлюз, занятый ею же.
 */
export function oqWrite<T>(fn: (w: OqWriter) => Promise<T>): Promise<T> {
  return getDb().transaction((tx) => fn(writer(tx, new Date())))
}
