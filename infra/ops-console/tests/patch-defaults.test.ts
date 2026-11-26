/**
 * PATCH не сбрасывает непереданные поля (IS-261, zod 4): `.partial()` в zod 4 подставляет `.default()` в непереданное
 * поле, поэтому PATCH-схемы строятся через `patchOf` (server/lib/validate.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { api, freshApp, login } from './helpers'
import { patchOf } from '../server/lib/validate'

describe('patchOf', () => {
  const schema = z.object({
    name: z.string().min(1),
    interval: z.number().int().min(30).default(60),
    tags: z.array(z.string()).default([]),
    note: z.string().nullable().default(null),
  })

  it('непереданное поле остаётся непереданным, переданное — проверяется', () => {
    expect(patchOf(schema).parse({})).toEqual({})
    expect(patchOf(schema).parse({ interval: 90 })).toEqual({ interval: 90 })
    expect(patchOf(schema).parse({ note: null })).toEqual({ note: null })
    expect(patchOf(schema).safeParse({ interval: 5 }).success).toBe(false)
    expect(patchOf(schema).safeParse({ name: '' }).success).toBe(false)
  })

  it('неизвестные поля срезаются, как у исходной схемы', () => {
    expect(patchOf(schema).parse({ name: 'a', extra: 1 })).toEqual({ name: 'a' })
  })
})

describe('PATCH сохраняет непереданные поля', () => {
  let owner: ReturnType<typeof api>
  beforeAll(async () => {
    const app = await freshApp()
    owner = api(app, await login(app))
  })

  it('монитор: переименование не трогает интервал, таймаут, публичность и включение', async () => {
    const created = await owner.post('/monitors', {
      name: 'web',
      url: 'https://example.com/',
      intervalSec: 300,
      timeoutMs: 5000,
      isPublic: true,
      enabled: false,
      keyword: 'ok',
    })
    expect(created.status).toBe(201)
    const id = created.json.monitor.id as number
    const res = await owner.patch(`/monitors/${id}`, { name: 'web 2' })
    expect(res.status).toBe(200)
    expect(res.json.monitor).toMatchObject({ name: 'web 2', intervalSec: 300, timeoutMs: 5000, isPublic: true, enabled: false, keyword: 'ok' })
  })

  it('правило алерта: переименование не включает выключенное и не сбрасывает порог', async () => {
    const created = await owner.post('/alerts/rules', {
      name: 'CPU',
      kind: 'host_metric',
      metric: 'cpu_pct',
      threshold: 90,
      severity: 'critical',
      repeatMin: 30,
      enabled: false,
    })
    expect(created.status).toBe(201)
    const res = await owner.patch(`/alerts/rules/${created.json.rule.id}`, { name: 'CPU 2' })
    expect(res.status).toBe(200)
    expect(res.json.rule).toMatchObject({ name: 'CPU 2', threshold: 90, severity: 'critical', repeatMin: 30, enabled: false, metric: 'cpu_pct' })
  })

  it('канал: переименование не требует адреса заново и не сбрасывает уровень и дайджест', async () => {
    const created = await owner.post('/channels', {
      kind: 'webhook',
      name: 'hook',
      config: { url: 'https://hooks.example.com/ops' },
      secrets: { signingSecret: 'test-signing-secret' },
      minSeverity: 'critical',
      digest: true,
    })
    expect(created.status).toBe(201)
    const res = await owner.patch(`/channels/${created.json.channel.id}`, { name: 'hook 2' })
    expect(res.status).toBe(200)
    expect(res.json.channel).toMatchObject({ name: 'hook 2', minSeverity: 'critical', digest: true, config: { url: 'https://hooks.example.com/ops' } })
    expect(res.json.channel.secretMasks.signingSecret).toBeTruthy()
  })
})
