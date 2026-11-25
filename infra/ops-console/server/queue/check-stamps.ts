/**
 * Серверные отметки ответа в checks (вынесено из store.ts: предел 500 строк). Их сравнивает правило «ждёт вас снова»
 * (open-rule.ts): страница /queue, API ?open=1, MCP open_only и бот решают по ним одинаково.
 */

/** Поля ответа владельца: их пишет только владелец. */
export const OWNER_FIELDS = ['done', 'choice', 'note', 'at'] as const
/** Поля агента в checks: замена документа владельцем (PUT) их не стирает (ревью #324, п. 5). */
export const AGENT_FIELDS = ['agentStatus', 'agentNote', 'agentBy', 'agentAt', 'blockedAt'] as const

/**
 * Серверные поля checks: agentAt — время последней записи агента (от него снимается захват, CLAIM_TTL_MS); ownerAt —
 * время сохранения ответа владельца; blockedAt — переход сессии в blocked или повторная просьба после ответа
 * (reblocksAfterAnswer). Присланные значения не принимаются. Замена документа владельцем сохраняет поля агента:
 * старые вкладки стирали бы захват и возвращали прежний статус.
 */
export function stampCheck(
  merged: Record<string, unknown>,
  before: Record<string, unknown> | null,
  data: Record<string, unknown>,
  o: { owner: boolean; merge: boolean; at: string },
): void {
  for (const k of ['ownerAt', 'blockedAt'] as const) {
    if (before?.[k] !== undefined) merged[k] = before[k]
    else delete merged[k]
  }
  if (o.owner && !o.merge && before) {
    for (const k of AGENT_FIELDS) if (before[k] !== undefined && !(k in data)) merged[k] = before[k]
  }
  if (o.owner && (OWNER_FIELDS as readonly string[]).some((k) => k in data)) merged.ownerAt = o.at
  if (!o.owner) {
    merged.agentAt = o.at
    if (merged.agentStatus === 'blocked' && (before?.agentStatus !== 'blocked' || reblocksAfterAnswer(before, data))) merged.blockedAt = o.at
  }
}

/**
 * Сессия снова просит владельца: прислала blocked явно, пункт уже был blocked, а владелец ответил позже прошлой
 * отметки. Это контракт oq_agent_status («ответил, но нужен снова — blocked и просьба в note»): без новой отметки
 * просьба терялась — API, MCP и бот считали пункт закрытым (s-sentry-enable-1911, 20.11: blocked 05:56, ответ 08:15,
 * blocked с новой просьбой 08:17). Заметка без статуса отметку не двигает (ревью «Контроля» #324, п. 4).
 */
function reblocksAfterAnswer(before: Record<string, unknown>, data: Record<string, unknown>): boolean {
  if (data.agentStatus !== 'blocked' || typeof before.ownerAt !== 'string') return false
  return typeof before.blockedAt !== 'string' || Date.parse(before.ownerAt) > Date.parse(before.blockedAt)
}
