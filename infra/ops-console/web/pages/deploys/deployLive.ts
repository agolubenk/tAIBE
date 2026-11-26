/** Живая карточка деплоя: подписи фаз и проверок, статусы для бейджей (чистые функции — tests/deploy-live-ui.test.ts). */
import type { DeployCard, DeployCardCheck, DeployCardPhase } from '../../../shared/deploy-events-contract'
import type { UiStatus } from '../../lib/types'

export { DEPLOY_CHECK_LABEL as CHECK_LABEL, DEPLOY_PHASE_LABEL as PHASE_LABEL } from '../../../shared/deploy-labels'

export function deployBadge(card: DeployCard): [UiStatus, string] {
  if (card.status === 'running') return ['pending', 'Идёт']
  if (card.status === 'success') return ['healthy', 'Успешно']
  if (card.status === 'stale') return ['unknown', 'Нет событий']
  return ['critical', card.rc !== null ? `Упал · код ${card.rc}` : 'Упал']
}

/** Идущая фаза у карточки без событий — «прервана»: деплой, скорее всего, убит. */
export function phaseBadge(p: DeployCardPhase, card: DeployCard): [UiStatus, string] {
  switch (p.status) {
    case 'ok':
      return ['healthy', 'Готово']
    case 'warn':
      return ['warning', 'С предупреждением']
    case 'failed':
      return ['critical', p.rc !== null ? `Ошибка · код ${p.rc}` : 'Ошибка']
    case 'running':
      return card.status === 'running' ? ['pending', 'Идёт'] : ['unknown', 'Прервана']
    case 'pending':
      return ['unknown', 'Ждёт']
    default:
      return ['unknown', 'Не выполнялась']
  }
}

export function checkBadge(c: DeployCardCheck, card: DeployCard): [UiStatus, string] {
  if (c.status === 'ok') return ['healthy', 'Отвечает']
  // Код 1 — проверка содержимого (site-config.js); остальные — код curl (22 — HTTP-ошибка, 7/28 — нет связи).
  if (c.status === 'failed') return ['critical', c.rc !== null && c.rc !== 1 ? `Ошибка · curl ${c.rc}` : 'Не прошла']
  return card.status === 'running' ? ['pending', 'Проверяется'] : ['unknown', 'Прервана']
}

/** Длительность «сейчас»: сервер посчитал её на момент ответа, прибавляем, сколько прошло у клиента. */
export function liveMs(baseMs: number | null, running: boolean, sinceFetchMs: number): number | null {
  if (baseMs === null) return null
  return running ? baseMs + Math.max(0, sinceFetchMs) : baseMs
}

export function rollbackSummary(card: DeployCard): string {
  const phase = card.phases.find((p) => p.key === 'rollback_prev')
  const r = card.rollback
  if (!phase || phase.status === 'pending') return 'ещё не ставился'
  if (!r) return 'не ставился: деплой до него не дошёл или не снял образы до сборки'
  if (r.changed === 0) return 'сервисы на тех же образах — тег не менялся'
  const parts = [`поставлен для ${r.changed - r.failed} из ${r.changed} сменившихся сервисов`]
  if (r.failed) parts.push(`не поставлен для ${r.failed} — их откат только пересборкой`)
  if (r.stuck) parts.push(`имя :rollback-pending не снято у ${r.stuck} — разберёт следующий деплой`)
  return parts.join('; ')
}

/** Первая упавшая фаза — с неё начинать разбор. */
export function failedPhase(card: DeployCard): DeployCardPhase | null {
  return card.phases.find((p) => p.status === 'failed') ?? null
}
