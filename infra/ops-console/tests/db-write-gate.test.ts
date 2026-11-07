/**
 * Запись консоли и занятая база (server/db/write-gate.ts): одновременные записи процесса не падают с SQLITE_BUSY.
 * Чужая блокировка (ночной бэкап, infra/scripts/prod/backup_ops_console.py в HR) — остаточный риск: запись падает сразу,
 * без синхронного ожидания. Читатель — python3, как у бэкапа: mode=ro, явная транзакция чтения.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { getEnv } from '../server/env'
import { createToken } from '../server/queue/auth'

const hasPython = spawnSync('python3', ['--version']).status === 0
const HOLD_SEC = 0.6

const READER = `
import sqlite3, sys, time
c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True, isolation_level=None)
c.execute('BEGIN')
c.execute('SELECT count(*) FROM sqlite_master').fetchone()
print('locked', flush=True)
time.sleep(float(sys.argv[2]))
c.execute('COMMIT')
`

let reader: ChildProcess | null = null
afterEach(() => {
  reader?.kill()
  reader = null
})

function holdReadLock(): Promise<void> {
  return new Promise((resolve, reject) => {
    reader = spawn('python3', ['-I', '-c', READER, getEnv().databaseUrl.slice('file:'.length), String(HOLD_SEC)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    reader.stderr?.on('data', (d) => (err += d))
    reader.stdout?.on('data', (d) => String(d).includes('locked') && resolve())
    reader.on('exit', (code) => reject(new Error(`читатель вышел (${code}) до блокировки: ${err}`)))
  })
}

/** Сколько раз за время fn сработал таймер 20 мс: стоящий цикл событий даёт около нуля. */
async function ticksDuring<T>(fn: () => Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
  let ticks = 0
  const timer = setInterval(() => ticks++, 20)
  const t0 = Date.now()
  try {
    const value = await fn()
    return { value, ticks, ms: Date.now() - t0 }
  } finally {
    clearInterval(timer)
  }
}

const decision = (title: string) => ({ kind: 'decision', title, options: [{ id: 'yes', label: 'Да' }], source: 'test' })

describe('шлюз записи', () => {
  it('одновременные записи процесса — все 200, без SQLITE_BUSY; следующие записи проходят', async () => {
    const app = await freshApp()
    const token = (await createToken('gate-agent', ['read', 'agent'])).token
    const put = (id: string) =>
      app.request(`/api/oq/v1/db/items/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: decision(id) }),
      })
    const first = await Promise.all(['d-g-1', 'd-g-2', 'd-g-3', 'd-g-4'].map(put))
    expect(first.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect((await put('d-g-5')).status).toBe(200)
  })

  it('одиночные записи вне транзакции (журнал, отметка токена) идут через тот же шлюз — не падают рядом с транзакцией', async () => {
    await freshApp()
    await getDb().run(sql`CREATE TABLE gate_probe (x INTEGER)`)
    const writes = Array.from({ length: 20 }, (_, i) =>
      i % 2 ? getDb().run(sql`INSERT INTO gate_probe (x) VALUES (${i})`) : getDb().transaction(async (tx) => { await tx.run(sql`INSERT INTO gate_probe (x) VALUES (${i})`) }),
    )
    await Promise.all(writes)
    expect(await getDb().all(sql`SELECT x FROM gate_probe`)).toHaveLength(20)
  })
})

describe.skipIf(!hasPython)('чужая блокировка чтения (бэкап) — остаточный риск', () => {
  it('запись под чужой блокировкой падает сразу с SQLITE_BUSY, без синхронного ожидания — цикл событий не стоит', async () => {
    await freshApp()
    await holdReadLock()
    const { value, ms } = await ticksDuring(() => getDb().run(sql`CREATE TABLE busy_probe (x INTEGER)`).then(() => null, (e: unknown) => e))
    // drizzle оборачивает ошибку драйвера: код — в cause.
    const err = value as { message?: string; cause?: { code?: string } } | null
    expect(`${err?.cause?.code ?? ''} ${err?.message ?? ''}`).toMatch(/SQLITE_BUSY|locked/i)
    expect(ms).toBeLessThan(HOLD_SEC * 1000 * 0.5)
  })
})

describe('прокси шлюза', () => {
  it('свойства клиента и транзакции читаются как у самого объекта (геттеры с приватными полями)', async () => {
    await freshApp()
    const client = (getDb() as unknown as { $client: { closed: boolean; transaction: () => Promise<{ closed: boolean; rollback: () => Promise<void> }> } }).$client
    expect(client.closed).toBe(false)
    const tx = await client.transaction()
    expect(tx.closed).toBe(false)
    await tx.rollback()
  })
})
