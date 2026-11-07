/**
 * Запись консоли и занятая база (server/db/write-gate.ts, client.ts): одновременные записи процесса идут по одной без
 * SQLITE_BUSY и без синхронного ожидания; чужая блокировка (ночной бэкап — infra/scripts/prod/backup_ops_console.py в HR,
 * CLI) дожидается таймаутом libsql, и запись, названная успешной, на диске. Чужие процессы — python3: читатель как у
 * бэкапа (mode=ro, явная транзакция чтения), писатель — BEGIN IMMEDIATE.
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
    const timed = async (id: string) => { const t0 = Date.now(); const r = await put(id); return { status: r.status, ms: Date.now() - t0 } }
    const first = await Promise.all(['d-g-1', 'd-g-2', 'd-g-3', 'd-g-4'].map(timed))
    expect(first.map((r) => r.status)).toEqual([200, 200, 200, 200])
    // Внутри процесса синхронного ожидания нет: каждая запись — без таймаута libsql (2 с).
    for (const r of first) expect(r.ms).toBeLessThan(1000)
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

const WRITER = `
import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute('BEGIN IMMEDIATE')
c.execute('INSERT INTO probe (x) VALUES (100)')
print('locked', flush=True)
time.sleep(float(sys.argv[2]))
c.execute('COMMIT')
`

/** Что видит другой процесс: запись, которую консоль назвала успешной, обязана быть на диске. */
const onDisk = () =>
  spawnSync('python3', ['-I', '-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1], timeout=0).execute("select group_concat(x) from probe").fetchone()[0])', getEnv().databaseUrl.slice('file:'.length)])
    .stdout.toString()
    .trim()

describe.skipIf(!hasPython)('чужая блокировка (бэкап, CLI)', () => {
  it('под блокировкой чтения бэкапа при идущих чтениях транзакция дожидается, следующие записи не падают, всё на диске', async () => {
    await freshApp()
    await getDb().run(sql`CREATE TABLE probe (x INTEGER)`)
    let stop = false
    const reads = (async () => {
      while (!stop) {
        await Promise.all([1, 2].map(() => getDb().all(sql`SELECT count(*) FROM probe`)))
        await new Promise((r) => setTimeout(r, 5))
      }
    })()
    await holdReadLock()
    await getDb().transaction(async (tx) => { await tx.run(sql`INSERT INTO probe (x) VALUES (1)`) })
    for (let i = 2; i <= 6; i++) await getDb().run(sql`INSERT INTO probe (x) VALUES (${i})`)
    stop = true
    await reads
    expect(onDisk()).toBe('1,2,3,4,5,6')
  })

  it('под блокировкой записи чужого процесса запись дожидается, а не «проходит» мимо диска', async () => {
    await freshApp()
    await getDb().run(sql`CREATE TABLE probe (x INTEGER)`)
    const writer = spawn('python3', ['-I', '-c', WRITER, getEnv().databaseUrl.slice('file:'.length), '0.3'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise((r) => writer.on('exit', r))
    await new Promise<void>((r) => writer.stdout?.on('data', (d) => String(d).includes('locked') && r()))
    await getDb().run(sql`INSERT INTO probe (x) VALUES (5)`)
    await exited
    await getDb().run(sql`INSERT INTO probe (x) VALUES (6)`)
    expect(onDisk()).toBe('100,5,6')
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
