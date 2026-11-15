/** Ограничения частоты для API очереди (по актору, в памяти процесса — консоль одна). */
import { apiError } from '../http-types'

const WINDOW_MS = 60_000

/** Списывает попытку актора; превышение — 429. Возвращает отмену списания (ответ 4xx не съедает лимит — writeCounted). */
function limiter(max: number, message: string, windowMs = WINDOW_MS) {
  const hits = new Map<string, number[]>()
  return (actor: string): (() => void) => {
    const now = Date.now()
    const recent = (hits.get(actor) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= max) throw apiError(429, message)
    recent.push(now)
    hits.set(actor, recent)
    return () => {
      const list = hits.get(actor)
      const i = list ? list.lastIndexOf(now) : -1
      if (i >= 0) list!.splice(i, 1)
    }
  }
}

// Не больше 120 записей в минуту на актора: агент в цикле не забьёт журнал и диск.
export const throttleWrite = limiter(120, 'Слишком много записей — не больше 120 в минуту')
// Все попытки записи, отказы тоже, — не больше 600 в минуту, без возврата: отказ стоит разбора тела и чтения базы, а
// писатель у консоли один (линзы backend и Контроля #361). Зациклившийся на 409 агент или утёкший ключ упрётся в 429.
export const throttleAttempt = limiter(600, 'Слишком много попыток записи — не больше 600 в минуту')
/**
 * Запись под лимитами: попытка — в throttleAttempt (не возвращается), запись — в throttleWrite. Отказ 4xx (неверное
 * тело, 403, 404, 409 версии, 422) ничего не записал — его запись возвращается в throttleWrite (GLM-ревью #221): агент,
 * повторяющий 409 после перечитывания, не упирается в 429 записей. 5xx и успех остаются списанными.
 */
export async function writeCounted<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  throttleAttempt(actor)
  const refund = throttleWrite(actor)
  try {
    return await fn()
  } catch (e) {
    const status = (e as { status?: unknown })?.status
    if (typeof status === 'number' && status >= 400 && status < 500) refund()
    throw e
  }
}
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
