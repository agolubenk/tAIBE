/** Срок хранения замеров: что удаляет ежедневная очистка и чем ищет последний замер счётчика (OPS-34). */
import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { freshApp } from './helpers'
import { getDb } from '../server/db/client'
import { containers, metricSamples } from '../server/db/schema'
import { pruneMetricSamples } from '../server/agents/metric-retention'

const DAY = 86_400_000
const now = Date.now()
const cutoff = new Date(now - 30 * DAY)
const ago = (days: number) => new Date(now - days * DAY)

beforeEach(async () => {
  await freshApp()
})

async function seed() {
  const db = getDb()
  // У nginx нет ни одной строки restarts: — его подзапрос даёт NULL. У redis строки есть, контейнера нет (удалён).
  await db.insert(containers).values(
    ['backend', 'worker', 'nginx'].map((name) => ({ agentId: 'a', name, state: 'running' })).concat([{ agentId: 'b', name: 'backend', state: 'running' }]),
  )
  await db.insert(metricSamples).values([
    { agentId: 'a', metric: 'cpu', value: 1, createdAt: ago(40) },
    { agentId: 'a', metric: 'cpu', value: 2, createdAt: ago(1) },
    { agentId: 'a', metric: 'restarts:backend', value: 1, createdAt: ago(50) },
    { agentId: 'a', metric: 'restarts:backend', value: 2, createdAt: ago(45) },
    { agentId: 'a', metric: 'restarts:worker', value: 7, createdAt: ago(60) },
    { agentId: 'a', metric: 'restarts:redis', value: 3, createdAt: ago(40) },
    { agentId: 'b', metric: 'restarts:backend', value: 9, createdAt: ago(35) },
    { agentId: 'b', metric: 'restarts:backend', value: 10, createdAt: ago(2) },
    { agentId: 'b', metric: 'mem', value: 5, createdAt: ago(31) },
  ])
}

const rows = async () =>
  (await getDb().select().from(metricSamples)).map((r) => `${r.agentId}/${r.metric}=${r.value}`).sort()

describe('срок хранения замеров (OPS-34)', () => {
  it('старое удаляется; последний замер счётчика каждого существующего контейнера остаётся, контейнер без счётчика не мешает', async () => {
    await seed()
    const res = await pruneMetricSamples(getDb(), cutoff)
    expect(res.rowsAffected).toBe(5)
    expect(await rows()).toEqual([
      'a/cpu=2',
      'a/restarts:backend=2',
      'a/restarts:worker=7',
      'b/restarts:backend=10',
    ])
  })

  it('без контейнеров очистка удаляет всё старое, включая счётчики', async () => {
    await getDb().insert(metricSamples).values([
      { agentId: 'a', metric: 'restarts:backend', value: 1, createdAt: ago(40) },
      { agentId: 'a', metric: 'cpu', value: 1, createdAt: ago(40) },
      { agentId: 'a', metric: 'cpu', value: 2, createdAt: ago(1) },
    ])
    await pruneMetricSamples(getDb(), cutoff)
    expect(await rows()).toEqual(['a/cpu=2'])
  })

  it('последний замер счётчика ищется по индексу на каждый контейнер, а не сканом истории', async () => {
    await seed()
    const plan = (await getDb().all<{ detail: string }>(sql`explain query plan ${pruneMetricSamples(getDb(), cutoff).getSQL()}`))
      .map((r) => r.detail)
      .join(' | ')
    expect(plan).toMatch(/SEARCH s USING (COVERING )?INDEX idx_metric_agent_time \(agent_id=\? AND metric=\?\)/)
    expect(plan).not.toMatch(/SCAN s\b/)
  })
})
