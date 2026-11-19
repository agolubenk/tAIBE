/**
 * «Памятки» в шапке /queue (page-memos.ts, d-queue-memos): какие документы work — памятки, их порядок и абзацы текста.
 * Чистые функции исполняются в vm, как tests/queue-page-files.test.ts.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { MEMOS_JS, MEMOS_PURE } from '../server/queue/page-memos'

interface Memo { id: string; title: string; body: string; cmds: Array<{ label: string; cmd: string; hidden: boolean }>; archived: boolean; source: string; version: number; updatedAt: number }
const ctx: Record<string, unknown> = {}
runInNewContext(`${MEMOS_PURE}\nthis.oqmList = oqmList; this.oqmParas = oqmParas; this.oqmReveal = oqmReveal; this.oqmByline = oqmByline;`, ctx)
const oqmReveal = ctx.oqmReveal as (s: unknown) => string
const oqmByline = ctx.oqmByline as (m: unknown) => string
const oqmList = ctx.oqmList as (docs: unknown) => Memo[]
const oqmParas = ctx.oqmParas as (body: unknown) => string[]

const memo = (id: string, data: Record<string, unknown>) => ({ id, data: { kind: 'memo', ...data } })

describe('памятки из снимка work', () => {
  it('только kind memo с id memo-… и заголовком; строки плана и сводки — нет', () => {
    const list = oqmList([
      memo('memo-phone-lost', { title: 'Телефон потерян или украден', order: 1 }),
      { id: 'w-taibe-x', data: { title: 'строка плана' } },
      { id: 'cards-stats', data: { kind: 'stats' } },
      memo('w-memo', { title: 'чужой id' }),
      memo('memo-empty', { title: '  ' }),
    ])
    expect(list.map((m) => m.id)).toEqual(['memo-phone-lost'])
    // Токен tAIBE пишет id с префиксом продукта: id без префикса принадлежит HR.
    expect(oqmList([memo('taibe-memo-x', { title: 'tAIBE' })]).map((m) => m.id)).toEqual(['taibe-memo-x'])
  })
  it('невидимые и меняющие направление символы — метками; такую команду не копировать; кто и когда записал', () => {
    expect(oqmReveal('rm\u202E-rf ~')).toBe('rm⟦U+202E⟧-rf ~')
    expect(oqmReveal('ssh\u200Broot@x')).toBe('ssh⟦U+200B⟧root@x')
    expect(oqmReveal('a\u001Bb\tc\nd')).toBe('a⟦U+001B⟧b\tc\nd') // ESC — меткой, табуляция и перенос — как есть
    const [m] = oqmList([{ id: 'memo-a', version: 3, updatedAt: new Date(2026, 10, 17, 16, 5).getTime(), data: { kind: 'memo', title: 'А', source: 'taibe-07', cmds: [{ cmd: 'ls\u2066 -la' }, { cmd: 'ls' }] } }])
    expect(m?.cmds.map((c) => c.hidden)).toEqual([true, false])
    expect(oqmByline(m)).toBe('Записал taibe-07, изменено 17.11 16:05')
  })
  it('порядок: order, затем новые раньше; скрытые помечены; команды без текста отброшены', () => {
    const list = oqmList([
      memo('memo-b', { title: 'Б', added: '2026-11-10' }),
      memo('memo-c', { title: 'В', added: '2026-11-17', archived: true }),
      memo('memo-a', { title: 'А', order: 1, cmds: [{ label: 'закрыть туннель', cmd: 'ssh root@x "bash y"' }, { cmd: ' ' }, null] }),
    ])
    expect(list.map((m) => [m.id, m.archived])).toEqual([['memo-a', false], ['memo-c', true], ['memo-b', false]])
    expect(list[0]?.cmds).toEqual([{ label: 'закрыть туннель', cmd: 'ssh root@x "bash y"', hidden: false }])
  })
  it('абзацы — через пустую строку, переносы внутри абзаца сохраняются', () => {
    expect(oqmParas('Первый\nвторая строка\n\n\r\nВторой  \n')).toEqual(['Первый\nвторая строка', 'Второй'])
    expect(oqmParas(null)).toEqual([])
  })
})

describe('скрипт страницы', () => {
  it('текст — textContent, скрыть — PATCH archived с CSRF, без своих опросов', () => {
    expect(MEMOS_JS).toContain("JSON.stringify({ data: { archived: on } })")
    expect(MEMOS_JS).toContain("'X-Ops-Csrf': '1'")
    expect(MEMOS_JS).not.toMatch(/innerHTML\s*=\s*(?!['"])\S/)
    expect(MEMOS_JS).not.toContain('setInterval')
    expect(() => new Function(MEMOS_JS)).not.toThrow()
  })
})
