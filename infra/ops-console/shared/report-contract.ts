/**
 * Контракт отчёта для ИИ-совета директоров продукта (`hrh.ops.report/v1`).
 *
 * Консоль шлёт его POST'ом с подписью:
 *   X-Ops-Timestamp: <unix ms>
 *   X-Ops-Signature: sha256=<hex HMAC-SHA256(key, `${timestamp}.${body}`)>
 * Приёмник обязан сверять подпись через timingSafeEqual и отклонять запросы старше 5 минут.
 *
 * Куда и каким ключом:
 *  - адрес и секрет заданы вручную («Отчёты ИИ-совету») — туда и этим секретом;
 *  - иначе, если есть связка с продуктом (вход через платформу: OPS_SSO_API_URL + OPS_SSO_CLIENT_SECRET),
 *    — в продукт `POST /api/v1/platform/ops-reports` ключом
 *      key = hex(HMAC-SHA256(OPS_SSO_CLIENT_SECRET, `${OPS_REPORT_KEY_LABEL}\n${origin консоли}`)),
 *    который используется строкой (UTF-8), как любой ключ webhook-подписи. Сам секрет SSO ключом не служит;
 *    origin привязывает ключ к этой консоли (продукт берёт его из своего OPS_CONSOLE_CALLBACK_URL).
 *
 * Персональных данных почти нет: имена сервисов и хостов, метрики, причины действий; исключение —
 * `restarts[].by` (email оператора консоли). Приёмник продукта отчёт целиком не хранит: только сводку
 * из чисел и имён сервисов для ИИ-совета.
 */
export const OPS_REPORT_SCHEMA = 'hrh.ops.report/v1' as const
export const OPS_REPORT_KEY_LABEL = 'hrh-ops/report-signing/v1' as const

export type OpsOverallStatus = 'healthy' | 'degraded' | 'critical'

export interface OpsReport {
  schema: typeof OPS_REPORT_SCHEMA
  source: { console: string; url: string }
  period: { kind: 'daily' | 'weekly'; start: string; end: string }
  generatedAt: string
  summary: { status: OpsOverallStatus; headline: string; highlights: string[] }
  availability: Array<{ monitor: string; url: string; uptimePct: number | null; checks: number; avgLatencyMs: number | null }>
  incidents: Array<{
    id: number
    title: string
    severity: 'warning' | 'critical'
    status: string
    startedAt: string
    resolvedAt: string | null
    durationMin: number | null
  }>
  alerts: {
    fired: number
    critical: number
    warning: number
    stillOpen: Array<{ title: string; object: string; severity: string; since: string }>
  }
  restarts: Array<{ agent: string; container: string; at: string; by: string; reason: string; result: string }>
  hosts: Array<{
    agent: string
    name: string
    cpuAvgPct: number | null
    cpuMaxPct: number | null
    memAvgPct: number | null
    diskMaxPct: number | null
    containersNotRunning: string[]
    /** Контейнеры по compose-проектам (OPS-8): стек продукта первым, name '' — без compose. В отчётах до OPS-8 поля нет. */
    projects?: Array<{ name: string; main: boolean; total: number; down: string[] }>
  }>
  deploys: { total: number; failed: number; recent: Array<{ title: string; conclusion: string | null; at: string; url: string }> }
  tls: Array<{ domain: string; daysLeft: number | null; error: string | null }>
  /** Правила, а не ИИ: подсказки по фактам периода (диск, рестарты, деградация SLA). */
  recommendations: string[]
}
