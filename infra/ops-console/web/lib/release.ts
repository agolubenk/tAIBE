/** Версия продукта: один ключ запроса для панели на «Деплоях» и строки в подвале меню (меню не тянет код страницы). */
import { api } from './api'
import type { ReleaseResponse } from '../../shared/release'

export const releaseQuery = { queryKey: ['release'], queryFn: () => api.get<ReleaseResponse>('/release') } as const
