/** Ограничения частоты для API очереди (по актору, в памяти процесса — консоль одна). */
import { apiError } from '../http-types'

const WINDOW_MS = 60_000

function limiter(max: number, message: string, windowMs = WINDOW_MS) {
  const hits = new Map<string, number[]>()
  return (actor: string): void => {
    const now = Date.now()
    const recent = (hits.get(actor) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= max) throw apiError(429, message)
    recent.push(now)
    hits.set(actor, recent)
  }
}

// Не больше 120 записей в минуту на актора: агент в цикле не забьёт журнал и диск.
export const throttleWrite = limiter(120, 'Слишком много записей — не больше 120 в минуту')
/** Скачивание вложений: файл до 20 МБ — не больше 60 в минуту на актора. */
export const throttleFileRead = limiter(60, 'Слишком много скачиваний — не больше 60 в минуту')
/**
 * Сводка вложений для страницы: дешёвая с ETag для сети, но не для сервера (statfs, выборка, хэш) — 120 в минуту на
 * актора. Страница спрашивает её раз в 4 с, пока ждёт файлы, и на смену входящих: с запасом на две вкладки.
 */
export const throttleSummary = limiter(120, 'Слишком частые запросы сводки — не больше 120 в минуту')
/**
 * События 2FA от backend продукта (POST /notify): 30 в час на токен — живых событий единицы в сутки, а утёкший
 * токен не превратит бот владельца в спам. Считаются все запросы, и повторы, и отказы схемы.
 */
export const throttleNotify = limiter(30, 'Слишком много уведомлений — не больше 30 в час на токен', 3_600_000)
