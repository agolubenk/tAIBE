/**
 * Типизированные настройки поверх таблицы settings (ключ → JSON). Каждое значение
 * проходит Zod-схему при чтении: ручная правка БД не протащит мусор в логику.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { settings } from '../db/schema'
import { isValidTimeZone } from '../lib/time'

export const githubSettingsSchema = z.object({
  repo: z.string().default('agolubenk/HR_Helper-v2'),
  workflow: z.string().default('deploy-contabo.yml'),
  tokenEnc: z.string().nullable().default(null),
  /** Отдельный токен с правом записи — мёржи и деплой из очереди владельца (server/queue/github.ts). */
  mergeTokenEnc: z.string().nullable().default(null),
})

export const reportSettingsSchema = z.object({
  /** По умолчанию включено: отчёты ИИ-совету — требование владельца; без приёмника хранятся здесь. */
  enabled: z.boolean().default(true),
  period: z.enum(['daily', 'weekly']).default('daily'),
  /** Час отправки (UTC). */
  hourUtc: z.number().int().min(0).max(23).default(6),
  /**
   * Свой приёмник. Пусто — в продукт автоматически, если есть связка (вход через платформу);
   * адрес без секрета — отчёт не уходит (молча в продукт не переключаемся).
   */
  destinationUrl: z.string().default(''),
  secretEnc: z.string().nullable().default(null),
  /** Устарело: период теперь в `report-period` (пишет только планировщик). Читается один раз как запасное. */
  lastPeriodKey: z.string().default(''),
})

/** Последний собранный по расписанию период («daily:2026-10-08»): отдельно от настроек владельца, чтобы
 *  планировщик и сохранение формы не перетирали друг друга. */
const reportPeriodSchema = z.object({ key: z.string().default('') })
export const readReportPeriod = async () => (await readSetting('report-period', reportPeriodSchema)).key
export const writeReportPeriod = (key: string) => writeSetting('report-period', { key })

export const generalSettingsSchema = z.object({
  consoleName: z.string().default('HR Helper Ops'),
  checkRetentionDays: z.number().int().min(1).max(90).default(30),
  metricRetentionDays: z.number().int().min(1).max(90).default(30),
  /** Лента событий (журнал действий) — дней. */
  activityRetentionDays: z.number().int().min(7).max(365).default(90),
  /** Журнал доставки уведомлений — дней. */
  deliveryRetentionDays: z.number().int().min(7).max(180).default(30),
  /** Суточные агрегаты проверок (SLA, страница статуса — 90 дней) — дней. */
  rollupRetentionDays: z.number().int().min(90).max(730).default(400),
  publicStatusEnabled: z.boolean().default(false),
  publicStatusTitle: z.string().default('Статус HR Helper'),
  /** Через сколько отчётов тишины агент считается «молчит» (× его интервал). */
  agentSilentAfterIntervals: z.number().int().min(2).max(40).default(4),
  /** Минимальная пауза между перезапусками одного контейнера, сек. */
  restartCooldownSec: z.number().int().min(30).max(3600).default(120),
  /**
   * Внутренние адреса (хосты/IP через запятую), куда владелец разрешил исходящие запросы
   * мониторов, webhook и отчётов: например «127.0.0.1, localhost» для локального dev-стека.
   * Пусто — только публичные адреса (защита от SSRF, server/lib/http.ts).
   */
  privateEgressHosts: z.string().max(500).default(''),
  /** Часовой пояс времени в уведомлениях («с 15:03»). */
  timezone: z
    .string()
    .max(64)
    .refine((tz) => isValidTimeZone(tz), 'неизвестный часовой пояс')
    .default('Europe/Minsk'),
  /** URL «пульса» (healthchecks.io и т. п.): консоль пингует его раз в минуту; нет пингов — внешний сервис бьёт тревогу. */
  heartbeatUrl: z.string().max(500).default(''),
})

export type GithubSettings = z.infer<typeof githubSettingsSchema>
export type ReportSettings = z.infer<typeof reportSettingsSchema>
export type GeneralSettings = z.infer<typeof generalSettingsSchema>

async function readRaw(key: string): Promise<unknown> {
  const row = await getDb().query.settings.findFirst({ where: eq(settings.key, key) })
  if (!row) return undefined
  try {
    return JSON.parse(row.value) as unknown
  } catch {
    return undefined
  }
}

export async function readSetting<T>(key: string, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse((await readRaw(key)) ?? {})
  return parsed.success ? parsed.data : schema.parse({})
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value)
  await getDb()
    .insert(settings)
    .values({ key, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: new Date() } })
}

export const getGithubSettings = () => readSetting('github', githubSettingsSchema)
export const getReportSettings = () => readSetting('reports', reportSettingsSchema)
export const getGeneralSettings = () => readSetting('general', generalSettingsSchema)

export async function getEgressAllowlist(): Promise<string[]> {
  const { privateEgressHosts } = await getGeneralSettings()
  return privateEgressHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/** Отметка «когда последний раз выполнялось» для периодических задач планировщика. */
export async function readMarker(key: string): Promise<number> {
  const v = await readRaw(`marker:${key}`)
  return typeof v === 'number' ? v : 0
}

export async function writeMarker(key: string, at: number): Promise<void> {
  await writeSetting(`marker:${key}`, at)
}
