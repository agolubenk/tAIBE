/**
 * Один опрос деплоев GitHub за раз. В процессе — общий промис: параллельные вызовы ждут один опрос. Между
 * процессами (локальный таймер, cron, serverless) — аренда `github-sync` в БД: её берут и тик планировщика, и
 * чтение версии продукта. Аренда занята — опрос пропускается без ошибки: его уже делает другой исполнитель.
 */
import { releaseLease, tryAcquireLease } from '../scheduler/lease'
import { syncGithubDeploys } from './github'

const LEASE = 'github-sync'
/** С запасом дольше опроса: список запусков (15 с) и шаги свежеупавших (по 10 с). */
const LEASE_MS = 90_000

export type SyncOnceResult = Awaited<ReturnType<typeof syncGithubDeploys>> | 'busy'

let inflight: Promise<SyncOnceResult> | null = null

async function syncLeased(): Promise<SyncOnceResult> {
  if (!(await tryAcquireLease(LEASE, LEASE_MS))) return 'busy'
  try {
    return await syncGithubDeploys()
  } finally {
    await releaseLease(LEASE).catch((err: unknown) => console.warn('[ops] github-sync lease release failed:', err instanceof Error ? err.message : err))
  }
}

export function syncGithubDeploysOnce(): Promise<SyncOnceResult> {
  inflight ??= syncLeased().finally(() => {
    inflight = null
  })
  return inflight
}
