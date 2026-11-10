/**
 * Миграция 0016 (HR Helper и Lavaeon — один продукт, tAIBE — отдельным): база проходит миграции до 0015, в неё кладутся
 * строки прежнего продукта lavaeon, затем migrator консоли докатывает 0016 — как на проде при деплое.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import { getEnv, setEnvForTests } from '../server/env'
import { getDb, resetDbForTests } from '../server/db/client'
import { oqDocs, oqEvents, oqProducts, oqTokens } from '../server/db/schema'

const MIGRATIONS = join(__dirname, '../server/db/migrations')
const MERGE_SQL = readFileSync(join(MIGRATIONS, '0016_oq_products_merge.sql'), 'utf8')

/** Копия каталога миграций, где журнал кончается на 0015: база «до деплоя». */
function migrationsBefore0016(dir: string): string {
  const out = join(dir, 'migrations-0015')
  cpSync(MIGRATIONS, out, { recursive: true })
  const journalPath = join(out, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter((e) => e.idx <= 15)
  writeFileSync(journalPath, JSON.stringify(journal))
  return out
}

const decision = (title: string) => JSON.stringify({ kind: 'decision', title, options: [{ id: 'yes', label: 'Да' }] })

const TOKENS: Array<[name: string, scopes: string, products: string]> = [
  ['only-lavaeon', 'read,agent', '["lavaeon"]'],
  ['hr-and-lavaeon', 'read,agent', '["hr-helper","lavaeon"]'],
  ['lavaeon-and-taibe', 'read,agent', '["lavaeon","taibe"]'],
  ['three', 'read,agent', '["taibe","lavaeon","hr-helper"]'],
  ['only-taibe', 'read,agent', '["taibe"]'],
  ['bot', 'owner', '["*"]'],
  ['broken', 'read', 'not json'],
  ['scalar', 'read', '"lavaeon"'],
  ['object', 'read', '{"p":"lavaeon"}'],
]

async function snapshot() {
  const db = getDb()
  return {
    products: await db.select({ slug: oqProducts.slug, name: oqProducts.name }).from(oqProducts).orderBy(asc(oqProducts.slug)),
    docs: await db.select({ collection: oqDocs.collection, id: oqDocs.id, product: oqDocs.product }).from(oqDocs).orderBy(asc(oqDocs.collection), asc(oqDocs.id)),
    events: await db.select({ docId: oqEvents.docId, product: oqEvents.product }).from(oqEvents).orderBy(asc(oqEvents.id)),
    tokens: Object.fromEntries((await db.select({ name: oqTokens.name, products: oqTokens.products }).from(oqTokens)).map((t) => [t.name, t.products])),
  }
}

let after: Awaited<ReturnType<typeof snapshot>>

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-console-0016-'))
  getEnv()
  setEnvForTests({ databaseUrl: `file:${join(dir, 'ops.db')}`, databaseAuthToken: undefined, isProduction: false })
  resetDbForTests()
  await migrate(getDb(), { migrationsFolder: migrationsBefore0016(dir) })
  const db = getDb()
  await db.insert(oqDocs).values([
    { collection: 'items', id: 'lavaeon-d-1', dataJson: decision('Lavaeon'), product: 'lavaeon' },
    { collection: 'checks', id: 'lavaeon-d-1', dataJson: JSON.stringify({ done: true }), product: 'lavaeon' },
    { collection: 'items', id: 'd-hr-1', dataJson: decision('HR'), product: 'hr-helper' },
    { collection: 'items', id: 'taibe-d-1', dataJson: decision('tAIBE'), product: 'taibe' },
    // Пункт tAIBE с id без префикса «taibe-» — как m-taibe-103 на проде: остаётся в hr-helper (причина — в 0016).
    { collection: 'items', id: 'm-taibe-103', dataJson: JSON.stringify({ kind: 'merge', title: 'Влить tAIBE #103', pr: 103 }), product: 'hr-helper' },
    { collection: 'checks', id: 'm-taibe-103', dataJson: JSON.stringify({ agentStatus: 'doing' }), product: 'hr-helper' },
  ])
  await db.insert(oqEvents).values([
    { actor: 'owner', collection: 'items', docId: 'lavaeon-d-1', action: 'product', product: 'lavaeon' },
    { actor: 'old-image', collection: 'items', docId: 'd-hr-1', action: 'set', product: null },
    { actor: 'taibe', collection: 'items', docId: 'taibe-d-1', action: 'set', product: 'taibe' },
  ])
  await db.insert(oqTokens).values(TOKENS.map(([name, scopes, products]) => ({ name, hash: `hash-${name}`, scopes, products })))
  expect((await snapshot()).products.map((p) => p.slug)).toEqual(['hr-helper', 'lavaeon', 'taibe'])
  await migrate(db, { migrationsFolder: MIGRATIONS })
  after = await snapshot()
})

describe('миграция 0016 — один продукт HR Helper и Lavaeon, tAIBE отдельным', () => {
  it('справочник: lavaeon удалён, hr-helper — «Lavaeon (HR Helper)», taibe — «tAIBE»', () => {
    expect(after.products).toEqual([
      { slug: 'hr-helper', name: 'Lavaeon (HR Helper)' },
      { slug: 'taibe', name: 'tAIBE' },
    ])
  })

  it('документы и события lavaeon — в hr-helper; tAIBE и событие без продукта не тронуты', () => {
    expect(after.docs).toEqual([
      { collection: 'checks', id: 'lavaeon-d-1', product: 'hr-helper' },
      { collection: 'checks', id: 'm-taibe-103', product: 'hr-helper' },
      { collection: 'items', id: 'd-hr-1', product: 'hr-helper' },
      { collection: 'items', id: 'lavaeon-d-1', product: 'hr-helper' },
      { collection: 'items', id: 'm-taibe-103', product: 'hr-helper' },
      { collection: 'items', id: 'taibe-d-1', product: 'taibe' },
    ])
    expect(after.events).toEqual([
      { docId: 'lavaeon-d-1', product: 'hr-helper' },
      { docId: 'd-hr-1', product: null },
      { docId: 'taibe-d-1', product: 'taibe' },
    ])
  })

  it('токены: lavaeon → hr-helper без повторов, порядок первого вхождения; не массив и «*» не тронуты', () => {
    expect(JSON.parse(after.tokens['only-lavaeon']!)).toEqual(['hr-helper'])
    expect(JSON.parse(after.tokens['hr-and-lavaeon']!)).toEqual(['hr-helper'])
    expect(JSON.parse(after.tokens['lavaeon-and-taibe']!)).toEqual(['hr-helper', 'taibe'])
    expect(JSON.parse(after.tokens['three']!)).toEqual(['taibe', 'hr-helper'])
    expect(after.tokens['only-taibe']).toBe('["taibe"]')
    expect(after.tokens['bot']).toBe('["*"]')
    expect(after.tokens['broken']).toBe('not json')
    expect(after.tokens['scalar']).toBe('"lavaeon"')
    expect(after.tokens['object']).toBe('{"p":"lavaeon"}')
  })

  it('повторный прогон тех же операторов ничего не меняет', async () => {
    for (const stmt of MERGE_SQL.split('--> statement-breakpoint')) await getDb().run(sql.raw(stmt))
    expect(await snapshot()).toEqual(after)
  })
})
