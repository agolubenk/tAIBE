// Правило срока строки плана (TB-112) без HTTP и базы: форма id решения и предел ссылок строки.
import { describe, expect, it } from 'vitest'
import type { oqDocs } from '../server/db/schema'
import { guardPlanEnd, moveToUnseen } from '../server/queue/plan-end'

type Row = typeof oqDocs.$inferSelect

const at = new Date('2026-11-13T10:00:00.000Z')
const row = (collection: string, id: string, data: unknown, updatedAt = at): Row =>
  ({ collection, id, dataJson: JSON.stringify(data), version: 1, createdAt: updatedAt, updatedAt, updatedBy: 't', product: 'taibe' }) as Row

/** Решение о сроках строки w-1 с ответом «перенести» после последней правки пункта. */
function store(dueRef: string) {
  const docs = new Map<string, Row>([
    [`items/${dueRef}`, row('items', dueRef, { kind: 'decision', rows: ['w-1'], moveTo: { 'w-1': '2026-12-01' } })],
    [`checks/${dueRef}`, row('checks', dueRef, { choice: 'move', ownerAt: '2026-11-13T10:05:00.000Z' })],
  ])
  return async (c: string, id: string) => docs.get(`${c}/${id}`)
}

const shift = (dueRef: string, before: Record<string, unknown>) => {
  const merged: Record<string, unknown> = { ...before, planEnd: '2026-11-30', dueRef }
  return guardPlanEnd('w-1', before, merged, store(dueRef), () => true).then(() => merged)
}

describe('guardPlanEnd (TB-112)', () => {
  it('id решения: «due» — отдельное слово; id плана досок d-<продукт>-due-YYYYMMDD проходит', async () => {
    const before = { planEnd: '2026-11-20' }
    for (const ok of ['d-taibe-due-20261113', 'd-hr-helper-due-20261113', 'd-t-due', 'd-t-due-plan']) {
      expect((await shift(ok, before)).dueRefs).toEqual([ok])
    }
    for (const bad of ['d-taibe-overdue-1', 'd-due-1', 'd-taibedue-1', 'x-taibe-due-1', 'd-taibe-dues']) {
      await expect(shift(bad, before)).rejects.toMatchObject({ status: 409 })
    }
  })

  it('ссылки строки не обрезаются: на пределе — 409, прежние ссылки на месте', async () => {
    const full = Array.from({ length: 50 }, (_, i) => `d-t-due-${i}`)
    await expect(shift('d-t-due-new', { planEnd: '2026-11-20', basePlanEnd: '2026-11-01', dueRefs: full })).rejects.toMatchObject({ status: 409 })
    const merged = await shift('d-t-due-new', { planEnd: '2026-11-20', basePlanEnd: '2026-11-01', dueRefs: full.slice(1) })
    expect(merged.dueRefs).toEqual([...full.slice(1), 'd-t-due-new'])
    expect(merged.basePlanEnd).toBe('2026-11-01')
  })

  it('ответ без отметки сервера ownerAt — не годится', async () => {
    const find = async (c: string, id: string) =>
      c === 'checks' ? row('checks', id, { choice: 'move' }) : row('items', id, { kind: 'decision', rows: ['w-1'], moveTo: { 'w-1': '2026-12-01' } })
    const merged = { planEnd: '2026-11-30', dueRef: 'd-t-due-1' }
    await expect(guardPlanEnd('w-1', { planEnd: '2026-11-20' }, merged, find, () => true)).rejects.toMatchObject({ status: 409 })
  })

  it('дата moveTo должна быть в тексте решения: YYYY-MM-DD или DD.MM, не часть другого числа', () => {
    const moveTo = { 'w-a': '2026-11-20', 'w-b': '2026-12-02' }
    expect(moveToUnseen(moveTo, 'A — на 20.11\nB — прогноз 02.12')).toBeUndefined()
    expect(moveToUnseen(moveTo, 'A — 2026-11-20, B — 02.12.2026')).toBeUndefined()
    expect(moveToUnseen(moveTo, 'A — на 20.11')).toEqual({ row: 'w-b', date: '2026-12-02' })
    expect(moveToUnseen(moveTo, 'A — на 120.11, B — 02.123')).toEqual({ row: 'w-a', date: '2026-11-20' })
    expect(moveToUnseen(moveTo, 'A — 20.11, B — 2.12')).toEqual({ row: 'w-b', date: '2026-12-02' })
    expect(moveToUnseen(undefined, '')).toBeUndefined()
  })
})
