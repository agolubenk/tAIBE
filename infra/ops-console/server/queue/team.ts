/**
 * Состояние команды ролей на Mac (OPS-82, d-queue-team-switch): сторож Mac (eval/tools/team_plan.py) раз в 10 минут
 * отмечается здесь — доли, сколько ролей открыто из нужного, роли сверх доли, память, пауза и почему роли не
 * открываются. Кнопка «Роли» в шапке /queue (page-team.ts) показывает его в меню и в тосте после выбора.
 *
 * Хранится одной настройкой (как отметка автопередачи, relay.ts), а не документом очереди: отметка раз в 10 минут не
 * меняет ETag коллекций, которые страница опрашивает каждые 4 с (иначе каждая отметка — полный список work и
 * перерисовка «Хода работ» у всех открытых страниц и у зеркала бота), и не пишет журнал oq_events.
 * Состояние общее для Mac (обе доли), продуктовых тайн в нём нет: видно любому актору с чтением очереди.
 */
import { z } from 'zod'
import { readSetting, writeSetting } from '../settings/store'
import { DOC_ID, SESSION_MAX } from './store'

const KEY = 'oq-team-mac'
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/)
const count = z.number().int().min(0).max(100)
const pairs = z.array(z.tuple([slug, count])).max(8)

export const teamBeatSchema = z.object({
  /** Пункт долей, ответ на который читает сторож (d-team-split). */
  item: z.string().regex(DOC_ID),
  total: count,
  /** Доли из ответа владельца, раскладка на деле (не больше ролей продукта) и число ролей продукта. */
  split: pairs.default([]),
  alloc: pairs.default([]),
  max: pairs.default([]),
  /** Откуда доли: «очередь», «последний ответ», «конфиг». */
  src: z.string().max(40).default(''),
  /** Ролей в раскладке, из них открыто, открыто сверх раскладки; null — сторож не дошёл до подсчёта (сбой). */
  want: count.nullable().default(null),
  live: count.nullable().default(null),
  extra: count.nullable().default(null),
  cap: count.nullable().default(null),
  /** Свободная память Mac, %. */
  mem: z.number().min(0).max(100).nullable().default(null),
  /** Пауза: на самом Mac, ответом в очереди или нет. */
  pause: z.enum(['', 'mac', 'queue']).default(''),
  /** Почему новые роли не открываются — текст владельцу; пусто — открываются. */
  hold: z.string().max(300).default(''),
  /** Кто отметился (имя токена сторожа) — для разбора, на странице не показывается. */
  by: z.string().max(SESSION_MAX).optional(),
})
export type TeamBeat = z.infer<typeof teamBeatSchema>

const storedSchema = teamBeatSchema.extend({ at: z.string() }).partial()
export type TeamView = Partial<TeamBeat> & { at?: string }

/** Последняя отметка сторожа; до первой — пустой объект. Время отметки ставит сервер: часам Mac не верим. */
export async function readTeam(): Promise<TeamView> {
  return readSetting(KEY, storedSchema)
}

export async function beatTeam(beat: TeamBeat, by: string, now = new Date()): Promise<TeamView> {
  const next = { ...beat, by: by.slice(0, SESSION_MAX), at: now.toISOString() }
  await writeSetting(KEY, next)
  return next
}
