/**
 * Сжатый JSON списка — одна сборка на тег: после записи все опросчики приходят разом, и на потолке 10 000 отдельные
 * сборки вышли бы за лимит памяти консоли. Одновременные промахи ждут одну сборку, сбой не кэшируется.
 * db в записи — тесты меняют базу между сценариями.
 */
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { getDb } from '../db/client'

const gzipAsync = promisify(gzip)

type Entry = { db: unknown; tag: string; body: Promise<Uint8Array> }
const cache = new Map<string, Entry>()

/** key — вид списка (коллекция или ?open=1), tag — его ETag; build — тело ответа, если тега нет в кэше. */
export function gzipListOnce(key: string, tag: string, build: () => Promise<unknown>): Promise<Uint8Array> {
  const db = getDb()
  const hit = cache.get(key)
  if (hit && hit.db === db && hit.tag === tag) return hit.body
  const body = build().then(async (v) => new Uint8Array(await gzipAsync(JSON.stringify(v))))
  cache.set(key, { db, tag, body })
  body.catch(() => {
    if (cache.get(key)?.body === body) cache.delete(key)
  })
  return body
}

/** Клиент принимает gzip: браузер, fetch Node (relay MCP), curl --compressed (Нерв). */
export const acceptsGzip = (header: string | undefined) => /\bgzip\b/i.test(header ?? '')
