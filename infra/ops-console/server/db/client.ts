/**
 * Подключение к БД: один клиент libSQL на процесс (на Vercel — на экземпляр функции).
 * Локально — файл `data/ops.db`, на Vercel — Turso по `libsql://` с токеном.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { getEnv } from '../env'
import * as schema from './schema'
import { gateClient } from './write-gate'

export type OpsDb = LibSQLDatabase<typeof schema>

/**
 * Сколько запись ждёт блокировку чужого процесса (бэкап, CLI), мс. Внутри процесса записи идут по одной (write-gate.ts),
 * поэтому синхронное ожидание libsql ждёт только чужую блокировку — копия бэкапа держит её миллисекунды. Без ожидания
 * упавший оператор libsql не сбрасывает, и следующая «успешная» запись на том же соединении терялась.
 */
export const BUSY_TIMEOUT_MS = 2000

let client: Client | null = null
let db: OpsDb | null = null

function ensureLocalDir(url: string): void {
  if (!url.startsWith('file:')) return
  const path = url.slice('file:'.length)
  if (path && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
}

export function getDb(): OpsDb {
  if (db) return db
  const env = getEnv()
  ensureLocalDir(env.databaseUrl)
  // Запись процесса — по одной (write-gate.ts); timeout — ожидание только чужой блокировки (у Turso игнорируется).
  client = gateClient(createClient({ url: env.databaseUrl, authToken: env.databaseAuthToken, timeout: BUSY_TIMEOUT_MS }))
  db = drizzle(client, { schema })
  return db
}

/** Только для тестов: новый изолированный клиент (обычно `file::memory:`). */
export function resetDbForTests(): void {
  client?.close()
  client = null
  db = null
}
