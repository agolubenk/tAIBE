/**
 * Кнопка «Роли» в шапке /queue (page-team.ts, OPS-82): варианты из пункта долей и пауза, подпись и точка
 * предупреждения, строка «что на Mac сейчас» из GET /team и текст тоста. Чистые функции исполняются в vm, как
 * tests/queue-page-files.test.ts.
 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { TEAM_JS, TEAM_PURE } from '../server/queue/page-team'

type Opt = { id: string; label: string }
interface Pure {
  oqtOptions(item: unknown, mac: unknown): Opt[]
  oqtWanted(check: unknown, mac?: unknown): string
  oqtState(check: unknown, opts: Opt[], mac: unknown, now: number): { label: string; pause: boolean; warn: boolean; quiet: boolean }
  oqtMacLine(mac: unknown, now: number): string
  oqtSavedText(opt: Opt, wasPause: boolean, mac: unknown, now: number): string
}
const ctx: Record<string, unknown> = {}
const NAMES = ['oqtOptions', 'oqtWanted', 'oqtState', 'oqtMacLine', 'oqtSavedText']
runInNewContext(`${TEAM_PURE}\n${NAMES.map((n) => `this.${n} = ${n};`).join('\n')}`, ctx)
const P = ctx as unknown as Pure

const ITEM = {
  options: [
    { id: '6-6', label: 'HR 6 · tAIBE 6', hint: 'рекомендую' },
    { id: '8-4', label: 'HR 8 · tAIBE 4' },
    { id: '10-2', label: 'HR 10 · tAIBE 2' },
    { id: 'other', label: 'не доля' },
    { id: '4-8', label: 42 },
  ],
}
const NOW = new Date(2026, 10, 17, 11, 0).getTime()
const at = (min: number) => new Date(NOW - min * 60000).toISOString()
const MAC = { at: at(3), total: 12, cap: 12, live: 12, want: 12, extra: 0, mem: 34.4, pause: '', hold: '', seen: true,
  split: [['hr-helper', 6], ['taibe', 6]], max: [['hr-helper', 8], ['taibe', 8]] }
const opts = P.oqtOptions(ITEM, MAC)

describe('варианты, подпись и точка', () => {
  it('только доли, которые Mac может держать, и пауза последней', () => {
    expect(opts.map((o) => o.id)).toEqual(['6-6', '8-4', 'pause']) // 10-2 при 8 ролях у HR — на деле 8-4
    expect(P.oqtOptions(ITEM, null).map((o) => o.id)).toEqual(['6-6', '8-4', '10-2', 'pause']) // Mac не известен
    expect(P.oqtOptions(null, MAC)).toEqual([])
    expect(P.oqtOptions({ options: [{ id: 'yes', label: 'Да' }] }, MAC)).toEqual([]) // без долей кнопки нет
  })
  it('доля из заметки важнее варианта, если сторож её примет — как parse_split', () => {
    expect(P.oqtWanted({ choice: '6-6', note: 'на неделю 7-5' }, MAC)).toBe('7-5')
    expect(P.oqtWanted({ choice: '8-4', note: 'с 18-11' }, MAC)).toBe('8-4') // 18+11 ≠ 12 — не доля
    expect(P.oqtWanted({ choice: '8-4', note: '' }, MAC)).toBe('8-4')
    expect(P.oqtWanted({ choice: 'pause', note: '7-5' }, MAC)).toBe('pause')
    expect(P.oqtWanted(null)).toBe('')
  })
  it('подпись и точка: предупреждение — пауза и простой; серая — Mac не на связи', () => {
    expect(P.oqtState({ choice: '8-4' }, opts, MAC, NOW)).toEqual({ label: 'Роли: HR 8 · tAIBE 4', pause: false, warn: false, quiet: false })
    expect(P.oqtState({ choice: 'pause' }, opts, MAC, NOW)).toEqual({ label: 'Роли: пауза', pause: true, warn: true, quiet: false })
    expect(P.oqtState({ choice: '6-6' }, opts, { ...MAC, pause: 'mac' }, NOW).label).toBe('Роли: пауза')
    expect(P.oqtState({ choice: '6-6' }, opts, { ...MAC, at: at(40) }, NOW)).toMatchObject({ warn: false, quiet: true })
    expect(P.oqtState({ choice: '6-6' }, opts, { ...MAC, hold: 'лимит Claude исчерпан до 15:00' }, NOW).warn).toBe(true)
    expect(P.oqtState({ choice: '6-6' }, opts, { ...MAC, seen: false }, NOW).warn).toBe(true)
    expect(P.oqtState({ choice: '6-6', note: '7-5' }, opts, MAC, NOW).label).toBe('Роли: 7-5')
    expect(P.oqtState(null, opts, null, NOW)).toEqual({ label: 'Роли', pause: false, warn: false, quiet: true })
  })
})

describe('что на Mac сейчас', () => {
  it('свежее состояние: открыто, память, роли сверх доли и причина простоя', () => {
    expect(P.oqtMacLine(MAC, NOW)).toBe('На Mac в 10:57: открыто 12 из 12 ролей, свободно памяти 34%.')
    expect(P.oqtMacLine({ ...MAC, live: 10, extra: 2, mem: null, hold: 'включена пауза — чтобы снять, выберите долю в «Роли»' }, NOW))
      .toBe('На Mac в 10:57: открыто 10 из 12 ролей. Ещё 2 роли сверх доли работают до конца своей сессии. Новые роли не открываются: включена пауза — чтобы снять, выберите долю в «Роли».')
    expect(P.oqtMacLine({ ...MAC, live: 1, want: 1, extra: 1 }, NOW)).toContain('открыто 1 из 1 роли, свободно памяти 34%. Ещё 1 роль сверх доли работает до конца своей сессии')
    expect(P.oqtMacLine({ ...MAC, live: 2, want: 12, extra: 5 }, NOW)).toContain('открыто 2 из 12 ролей, свободно памяти 34%. Ещё 5 ролей сверх доли работают до конца')
    expect(P.oqtMacLine({ ...MAC, seen: false }, NOW)).toContain('Mac не видит пункт долей')
  })
  it('Mac не на связи дольше 25 мин или не присылал вовсе', () => {
    expect(P.oqtMacLine({ ...MAC, at: at(40) }, NOW)).toBe(
      'Mac не на связи с 10:20 (выключен, спит или разработка выключена). Выбор применится, когда он включится.')
    expect(P.oqtMacLine({ ...MAC, at: at(60 * 24) }, NOW)).toContain('с 16.11 11:00')
    expect(P.oqtMacLine(null, NOW)).toBe('Mac ещё не присылал состояние.')
    expect(P.oqtMacLine({ at: 'вчера' }, NOW)).toBe('Mac ещё не присылал состояние.')
  })
  it('сбой сторожа и чужие типы не ломают строку', () => {
    expect(P.oqtMacLine({ at: at(1), live: null, want: null, hold: 'сбой сторожа Mac' }, NOW))
      .toBe('На Mac в 10:59: сколько ролей открыто — неизвестно. Новые роли не открываются: сбой сторожа Mac.')
    expect(P.oqtMacLine({ at: at(1), live: '12', want: -1, mem: 'x' }, NOW)).toBe('На Mac в 10:59: сколько ролей открыто — неизвестно.')
  })
})

describe('тост после выбора', () => {
  const opt = { id: '8-4', label: 'HR 8 · tAIBE 4' }
  it('есть свободные места — срок; все заняты — когда роли сверх доли закончат сессию', () => {
    const roomy = { ...MAC, live: 10 }
    expect(P.oqtSavedText(opt, false, roomy, NOW)).toBe('Сохранено: HR 8 · tAIBE 4. Mac начнёт применять в течение 10 минут. Открытые роли не закрываются.')
    expect(P.oqtSavedText(opt, true, { ...roomy, pause: 'queue', hold: 'включена пауза' }, NOW)).toContain('в течение 10 минут и снимет паузу')
    expect(P.oqtSavedText(opt, false, MAC, NOW)).toBe('Сохранено: HR 8 · tAIBE 4. Все 12 мест заняты, открытые роли не закрываются. Новая доля заработает, когда лишние роли закончат свою сессию (обычно за несколько часов), или сразу после «Разработка ВЫКЛ → ВКЛ».')
    expect(P.oqtSavedText(opt, false, { ...MAC, seen: false }, NOW)).toBe('Сохранено: HR 8 · tAIBE 4. Открытые роли не закрываются.')
    expect(P.oqtSavedText({ id: 'pause', label: 'Пауза' }, false, MAC, NOW))
      .toBe('Пауза сохранена. Через 10 минут Mac перестанет открывать новые роли. Открытые роли продолжают работать.')
  })
  it('Mac не на связи или стоит не из-за паузы — без обещания срока', () => {
    expect(P.oqtSavedText(opt, false, { ...MAC, at: at(40) }, NOW)).toBe('Сохранено: HR 8 · tAIBE 4. Открытые роли не закрываются.')
    expect(P.oqtSavedText(opt, false, { ...MAC, hold: 'лимит Claude исчерпан до 15:00' }, NOW)).not.toContain('10 минут')
    expect(P.oqtSavedText({ id: 'pause', label: 'Пауза' }, false, null, NOW)).toBe('Пауза сохранена. Открытые роли продолжают работать.')
  })
})

describe('скрипт страницы', () => {
  it('пишет ответ в checks тем же путём, что страница; состояние Mac — GET /team; пункт — постоянный', () => {
    expect(TEAM_JS).toContain("method: 'PATCH'")
    expect(TEAM_JS).toContain("'X-Ops-Csrf': '1'")
    expect(TEAM_JS).toContain('ifAnswerAt: base')
    expect(TEAM_JS).toContain("TEAM = '/api/oq/v1/team'")
    expect(TEAM_JS).not.toContain('mac.item')
    expect(TEAM_JS).not.toMatch(/innerHTML\s*=\s*(?!['"])\S/) // разметка — только постоянный SVG, текст — textContent
    expect(() => new Function(TEAM_JS)).not.toThrow() // синтаксис
  })
})
