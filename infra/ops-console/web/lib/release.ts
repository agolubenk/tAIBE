/**
 * Версия продукта: запросы панели на «Деплоях» и строки в подвале меню (меню не тянет код страницы). Все ключи
 * начинаются с ['release'] — сброс этого ключа обновляет и панель, и подвал, и предложение.
 */
import { api } from './api'
import type { ReleaseNav, ReleaseResponse, ReleaseSuggestionResponse } from '../../shared/release'

export const releaseQuery = { queryKey: ['release'], queryFn: () => api.get<ReleaseResponse>('/release') } as const

/** Подвал меню: без опроса GitHub, только версия и SHA. */
export const releaseNavQuery = { queryKey: ['release', 'nav'], queryFn: () => api.get<ReleaseNav>('/release?view=nav') } as const

/** Предложение владельцу — отдельно: GitHub может отвечать секунды, основная панель его не ждёт. */
export const releaseSuggestionQuery = (rev: number, head: string | null) =>
  ({
    queryKey: ['release', 'suggestion', rev, head ?? ''],
    queryFn: () => api.get<ReleaseSuggestionResponse>('/release/suggestion'),
  }) as const
