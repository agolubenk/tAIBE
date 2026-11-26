/**
 * Контракт «скрипт деплоя → консоль» (POST /api/agent/deploy-events). Отправитель —
 * infra/scripts/prod/ops-deploy-event.py: его зовёт contabo-deploy.sh через
 * infra/scripts/prod/lib/ops-deploy-events.sh под учёткой агента хоста (та же подпись, что у отчётов).
 *
 * Каждое событие несёт НАКОПЛЕННУЮ сводку деплоя. Консоль сама перезапускается на шаге `up`, и события
 * в этот момент теряются: карточку соберёт любое следующее событие, финальное deploy_done несёт всё.
 * Время в событии — unix-секунды хоста; в карточке для интерфейса — миллисекунды.
 */
import { z } from 'zod'

export const DEPLOY_EVENT_PATH = '/api/agent/deploy-events'
/** Сводка занимает единицы КБ; 16 КБ — запас в разы и потолок против раздувания БД. */
export const DEPLOY_EVENT_MAX_BYTES = 16 * 1024

export const DEPLOY_EVENT_TYPES = [
  'deploy_start',
  'prepare',
  'build_start',
  'build_done',
  'rollback_prev',
  'nginx_apply',
  'health_checks',
  'deploy_done',
] as const

/**
 * Фазы contabo-deploy.sh по порядку. Миграции и подъём стека идут внутри rebuild-prod-stack.sh одной
 * командой — для скрипта деплоя это одна фаза build (её код возврата и длительность).
 */
export const DEPLOY_PHASES = ['preflight', 'prepare', 'build', 'rollback_prev', 'cleanup', 'nginx', 'checks'] as const

/** Подписи — в отдельном модуле без zod: их берёт web-бандл (web/pages/deploys/deployLive.ts). */
export { DEPLOY_CHECK_LABEL, DEPLOY_PHASE_LABEL } from './deploy-labels'

const unixSec = z.number().int().min(1_577_836_800).max(4_102_444_800)
const exitCode = z.number().int().min(0).max(255)
const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)

export const deployPhaseSchema = z.object({
  key,
  status: z.enum(['running', 'ok', 'warn', 'failed', 'skipped']),
  startedAt: unixSec.nullable(),
  endedAt: unixSec.nullable(),
  rc: exitCode.nullable(),
})

/** Адрес проверки показывается ссылкой: только https и безопасные символы пути. */
export const deployCheckUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/[A-Za-z0-9._~/-]{0,200}$/)

export const deployCheckSchema = z.object({
  key: key.nullable(),
  url: deployCheckUrl,
  status: z.enum(['running', 'ok', 'failed']),
  rc: exitCode.nullable(),
  startedAt: unixSec.nullable(),
  endedAt: unixSec.nullable(),
})

/** Итог tag_rollback_prev: сервисы, сменившие образ; без rollback-prev; с неснятым :rollback-pending. */
export const deployRollbackSchema = z.object({
  changed: z.number().int().min(0).max(64),
  failed: z.number().int().min(0).max(64),
  stuck: z.number().int().min(0).max(64),
})

export const deployEventSchema = z
  .object({
    v: z.literal(1),
    deployId: z.string().regex(/^[0-9a-f]{40}-\d{10}$/),
    seq: z.number().int().min(1).max(10_000),
    type: z.enum(DEPLOY_EVENT_TYPES),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    startedAt: unixSec,
    at: unixSec,
    phases: z.array(deployPhaseSchema).max(16),
    checks: z.array(deployCheckSchema).max(16),
    rollback: deployRollbackSchema.nullable(),
    /** Код выхода contabo-deploy.sh — только у deploy_done. */
    rc: exitCode.nullable(),
  })
  .refine((e) => e.deployId === `${e.sha}-${e.startedAt}`, { message: 'deployId — это sha и время старта', path: ['deployId'] })
  .refine((e) => e.at >= e.startedAt, { message: 'событие раньше старта деплоя', path: ['at'] })
  .refine((e) => (e.type === 'deploy_done') === (e.rc !== null), { message: 'код выхода — только и обязательно у deploy_done', path: ['rc'] })

export type DeployEvent = z.infer<typeof deployEventSchema>

/** Сводка, которую консоль хранит по карточке: последнее по seq событие. */
export const deploySummarySchema = z.object({
  phases: z.array(deployPhaseSchema).max(16).default([]),
  checks: z.array(deployCheckSchema).max(16).default([]),
  rollback: deployRollbackSchema.nullable().default(null),
})
export type DeploySummary = z.infer<typeof deploySummarySchema>

// ── Карточка для интерфейса (GET /api/events/deploys/live) ─────────────────

export type DeployPhaseStatus = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped'

export interface DeployCardPhase {
  key: string
  status: DeployPhaseStatus
  startedAt: number | null
  endedAt: number | null
  /** Для идущей фазы — от старта до serverTime. */
  durationMs: number | null
  rc: number | null
}

export interface DeployCardCheck {
  key: string | null
  url: string
  status: 'running' | 'ok' | 'failed'
  rc: number | null
  durationMs: number | null
}

export interface DeployCardRun {
  runKey: string
  url: string
  title: string
  status: string
  conclusion: string | null
}

export interface DeployCard {
  id: number
  agentId: string
  agentName: string
  deployId: string
  sha: string
  /** stale — идёт, но событий давно нет (сервер перезагрузили, деплой убит) или запуск GitHub уже завершён. */
  status: 'running' | 'success' | 'failed' | 'stale'
  startedAt: number
  finishedAt: number | null
  durationMs: number
  lastEventAt: number
  rc: number | null
  phases: DeployCardPhase[]
  checks: DeployCardCheck[]
  rollback: z.infer<typeof deployRollbackSchema> | null
  events: { received: number; lastSeq: number; missing: number[] }
  run: DeployCardRun | null
}

export interface DeployLiveResponse {
  serverTime: number
  card: DeployCard | null
}
