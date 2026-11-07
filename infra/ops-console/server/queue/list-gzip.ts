/**
 * Сжатый JSON списка — одна сборка на тег: после записи все опросчики приходят разом, и на потолке отдельные сборки
 * вышли бы за лимит памяти консоли. Пока сборка идёт, новый тег её не дублирует: запрос получает её тело с её тегом
 * (тело не старше тега — следующий опрос возьмёт свежее). На ключ — не больше одной сборки; сбой не кэшируется.
 * db в записи — тесты меняют базу между сценариями.
 * v2-lite: ключ — с набором продуктов, видимых токену, иначе тело одного продукта уйдёт токену другого.
 */
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { getDb } from '../db/client'

const gzipAsync = promisify(gzip)

type Entry = { db: unknown; tag: string; body: Promise<Uint8Array>; pending: boolean }
const cache = new Map<string, Entry>()

/** key — вид списка (коллекция или ?open=1), tag — его ETag; build — тело ответа. Возвращает тело и тег этого тела. */
export function gzipListOnce(key: string, tag: string, build: () => Promise<unknown>): { tag: string; body: Promise<Uint8Array> } {
  const db = getDb()
  const hit = cache.get(key)
  if (hit && hit.db === db && (hit.tag === tag || hit.pending)) return { tag: hit.tag, body: hit.body }
  const entry: Entry = { db, tag, pending: true, body: build().then(async (v) => new Uint8Array(await gzipAsync(JSON.stringify(v)))) }
  cache.set(key, entry)
  entry.body.then(
    () => {
      entry.pending = false
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return { tag, body: entry.body }
}

/** Клиент принимает gzip: браузер, fetch Node (relay MCP), curl --compressed (Нерв). */
export const acceptsGzip = (header: string | undefined) => /\bgzip\b/i.test(header ?? '')
