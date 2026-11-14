/**
 * Один путь записи очереди (TB-153, docs/specs/owner-queue-move.md §5.3 п. 1): в oq_docs, oq_events и oq_files пишет
 * только server/queue/oq-write.ts, и время с остальными DEFAULT-значениями ставит он, а не БД. Иначе после переезда в
 * Postgres два хранилища получат разные строки, и сверка с историей разойдутся.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { oqDocs, oqEvents, oqFiles } from '../server/db/schema'
import { oqWrite } from '../server/queue/oq-write'
import { changeItemProduct } from '../server/queue/product-change'
import { deleteDoc, importDoc, logEvent, writeDoc, type Actor } from '../server/queue/store'

const SERVER = fileURLToPath(new URL('../server', import.meta.url))
const WRITER = join(SERVER, 'queue', 'oq-write.ts')
const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*(oqDocs|oqEvents|oqFiles)\s*\)/
const SQL_WRITE = /\b(insert\s+into|update|delete\s+from)\s+["`]?oq_(docs|events|files)\b/i
const TABLES = /\b(oqDocs|oqEvents|oqFiles)\b|\boq_(docs|events|files)\b/
const TRANSACTION = /\.transaction\(/

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  )

describe('один путь записи: исходники', () => {
  it('мимо oq-write.ts в таблицы очереди никто не пишет и пишущих транзакций не открывает', () => {
    const offenders = tsFiles(SERVER)
      .filter((f) => f !== WRITER)
      .flatMap((f) => {
        const src = readFileSync(f, 'utf8')
        const hits: string[] = []
        if (DRIZZLE_WRITE.test(src) || SQL_WRITE.test(src)) hits.push('запись в oq_*')
        if (TABLES.test(src) && TRANSACTION.test(src)) hits.push('своя транзакция рядом с oq_*')
        return hits.map((h) => `${relative(SERVER, f)}: ${h}`)
      })
    expect(offenders).toEqual([])
  })

  it('шаблоны ловят настоящий код: на самом oq-write.ts они срабатывают', () => {
    const src = readFileSync(WRITER, 'utf8')
    expect([DRIZZLE_WRITE.test(src), SQL_WRITE.test(src), TABLES.test(src), TRANSACTION.test(src)]).toEqual([true, true, true, true])
  })
})

describe('один путь записи: время и значения по умолчанию', () => {
  // Часы JS сдвинуты в 2001 год, а DEFAULT SQLite (unixepoch) берёт настоящее время: строка с меткой 2001 года
  // значит, что метку поставил путь записи. Подменяется только Date — таймеры шлюза записи работают как обычно.
  const T = new Date('2001-02-03T04:05:06.789Z')
  const owner: Actor = { name: 'one-writer', scopes: ['owner'], products: '*' }

  beforeAll(async () => {
    await freshApp()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T)
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('документ, событие и вложение получают время транзакции, а не DEFAULT БД', async () => {
    const decision = { kind: 'decision', title: 'один писатель', options: [{ id: 'a', label: 'A' }], source: 'test' }
    await writeDoc(owner, 'items', 'd-one-writer', decision, { merge: false })
    await writeDoc(owner, 'checks', 'd-one-writer', { done: true, at: T.toISOString() }, { merge: true })
    await changeItemProduct(owner, 'd-one-writer', 'taibe', 'проверка одного писателя')
    expect(await importDoc('work', 'w-one-writer', { title: 'импорт' }, 'one-writer-import')).toBe('added')
    await deleteDoc(owner, 'work', 'w-one-writer')
    await logEvent('one-writer', 'deploy', 'main', 'redeploy', undefined, null)
    const file = { id: 'f-one-writer', itemId: 'd-one-writer', name: 'a.txt', kind: 'text', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64), createdBy: 'one-writer' }
    expect(await oqWrite((w) => w.insertFileIfRoom(file, { maxPerItem: 5, capBytes: 1_000_000 }))).toBe(true)

    const db = getDb()
    const docs = await db.select().from(oqDocs).where(inArray(oqDocs.id, ['d-one-writer']))
    expect(docs.map((d) => [d.collection, d.createdAt.getTime(), d.updatedAt.getTime()]).sort()).toEqual([
      ['checks', T.getTime(), T.getTime()],
      ['items', T.getTime(), T.getTime()],
    ])
    const events = await db.select().from(oqEvents).where(inArray(oqEvents.actor, ['one-writer', 'one-writer-import']))
    // set, update, product ×4 (пункт и ответ — в обоих продуктах), import, delete, redeploy
    expect(events.map((e) => e.action).sort()).toEqual(['delete', 'import', 'product', 'product', 'product', 'product', 'redeploy', 'set', 'update'])
    expect(events.filter((e) => e.at.getTime() !== T.getTime())).toEqual([])
    const [row] = await db.select().from(oqFiles).where(inArray(oqFiles.id, ['f-one-writer']))
    expect(row?.createdAt.getTime()).toBe(T.getTime())
  })
})
