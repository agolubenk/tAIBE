/**
 * Кнопка «Роли» в шапке /queue (page-team.ts, OPS-82): варианты из пункта долей и пауза, подпись кнопки, строка
 * «что на Mac сейчас» из work/team-mac и текст тоста. Чистые функции исполняются в vm, как tests/queue-page-files.test.ts.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { TEAM_JS, TEAM_PURE } from '../server/queue/page-team'

type Opt = { id: string; label: string }
interface Pure {
  oqtOptions(item: unknown): Opt[]
  oqtLabel(choice: unknown, opts: Opt[], mac: unknown): [string, string]
  oqtMacLine(mac: unknown, now: number): string
  oqtSavedText(opt: Opt, wasPause: boolean): string
}
const ctx: Record<string, unknown> = {}
runInNewContext(`${TEAM_PURE}\nthis.oqtOptions = oqtOptions; this.oqtLabel = oqtLabel; this.oqtMacLine = oqtMacLine; this.oqtSavedText = oqtSavedText;`, ctx)
const P = ctx as unknown as Pure

const ITEM = {
  options: [
    { id: '6-6', label: 'HR 6 · tAIBE 6', hint: 'рекомендую' },
    { id: '8-4', label: 'HR 8 · tAIBE 4' },
    { id: 'other', label: 'не доля' },
    { id: '10-2', label: 42 },
  ],
}
const NOW = new Date(2026, 10, 17, 11, 0).getTime()
const at = (min: number) => new Date(NOW - min * 60000).toISOString()

describe('варианты и подпись', () => {
  it('берёт из пункта только доли с подписью и добавляет паузу последней', () => {
    expect(P.oqtOptions(ITEM).map((o) => o.id)).toEqual(['6-6', '8-4', 'pause'])
    expect(P.oqtOptions(null)).toEqual([])
    expect(P.oqtOptions({ options: [{ id: 'yes', label: 'Да' }] })).toEqual([]) // без долей кнопки нет
  })
  it('подпись — выбранная доля, пауза или доля, которую держит Mac', () => {
    const opts = P.oqtOptions(ITEM)
    expect(P.oqtLabel('8-4', opts, null)).toEqual(['Роли: HR 8 · tAIBE 4', '8·4'])
    expect(P.oqtLabel('pause', opts, null)).toEqual(['Роли: пауза', '⏸'])
    expect(P.oqtLabel(null, opts, { split: [['hr-helper', 6], ['taibe', 6]] })).toEqual(['Роли: HR 6 · tAIBE 6', '6·6'])
    expect(P.oqtLabel('7-5', opts, null)).toEqual(['Роли: 7-5', '7·5']) // доля из заметки — без подписи пункта
    expect(P.oqtLabel(null, opts, { split: [['x', 'шесть']] })).toEqual(['Роли', 'Роли'])
  })
})

describe('что на Mac сейчас', () => {
  it('свежее состояние: открыто, память, время и причина простоя', () => {
    expect(P.oqtMacLine({ at: at(3), live: 12, want: 12, mem: 34.4, hold: '' }, NOW))
      .toBe('Сейчас на Mac: открыто 12 из 12, памяти свободно 34%, обновлено 10:57.')
    expect(P.oqtMacLine({ at: at(1), live: 2, want: 12, mem: null, hold: 'пауза владельца в очереди' }, NOW))
      .toBe('Сейчас на Mac: открыто 2 из 12, обновлено 10:59. Роли сейчас не открываются: пауза владельца в очереди.')
  })
  it('сторож молчит дольше 25 мин или не писал вовсе', () => {
    expect(P.oqtMacLine({ at: at(40), live: 12, want: 12 }, NOW)).toBe(
      'Сторож Mac молчит с 10:20: Mac выключен или спит — выбор применится, когда он проснётся.')
    expect(P.oqtMacLine({ at: at(60 * 24), live: 12, want: 12 }, NOW)).toContain('молчит с 16.11 11:00')
    expect(P.oqtMacLine(null, NOW)).toBe('Состояние Mac неизвестно: сторож ещё не писал его в очередь.')
    expect(P.oqtMacLine({ at: 'вчера' }, NOW)).toContain('неизвестно')
  })
  it('чужие типы в документе не ломают строку', () => {
    expect(P.oqtMacLine({ at: at(1), live: '12', want: -1, mem: 'x' }, NOW)).toBe('Сейчас на Mac: открыто ? из ?, обновлено 10:59.')
  })
})

describe('тост после выбора', () => {
  it('доля, снятие паузы и пауза', () => {
    const opt = { id: '8-4', label: 'HR 8 · tAIBE 4' }
    expect(P.oqtSavedText(opt, false)).toBe(
      'Сохранено: HR 8 · tAIBE 4. Сторож Mac применит в течение 10 минут. Уменьшение доли не закрывает работающие роли.')
    expect(P.oqtSavedText(opt, true)).toContain('применит в течение 10 минут и снимет паузу')
    expect(P.oqtSavedText({ id: 'pause', label: 'Пауза' }, false)).toContain('перестанет открывать новые роли')
  })
})

describe('скрипт страницы', () => {
  it('пишет ответ в checks тем же путём, что страница, и не трогает задачи плана', () => {
    expect(TEAM_JS).toContain("method: 'PATCH'")
    expect(TEAM_JS).toContain("'X-Ops-Csrf': '1'")
    expect(TEAM_JS).toContain('ifAnswerAt: base')
    expect(TEAM_JS).toContain("DOC = 'work/team-mac'")
    expect(() => new Function(TEAM_JS)).not.toThrow() // синтаксис
  })
})
