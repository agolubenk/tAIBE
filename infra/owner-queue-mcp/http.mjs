// Запрос к API консоли очереди (OPS-79): таймаут на весь запрос вместе с телом и тело 2xx — только разобранный JSON.
// Раньше таймаут был один, 20 с, а оборванное тело при 200 становилось ответом `{}`. Полный список /changes
// (1,64 МБ gzip, 43 с на 15.11, HR OPS-22) обрывался, `{}` дельта считала нарушением контракта и сбрасывала
// зеркало на 30 мин, а прежний путь (тот же объём) обрывался так же.

/** Обычный запрос: пункт, отметка, запись, дельта от курсора. */
export const TIMEOUT_MS = 20_000;
/** Коллекция целиком (полный /changes, GET /db/:col): её объём растёт с очередью, 43 с на 15.11 — запас втрое. */
export const LIST_TIMEOUT_MS = 120_000;

const positive = (raw, dflt) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

/** Таймауты из env (OQ_TIMEOUT_MS, OQ_LIST_TIMEOUT_MS — для тестов и медленной сети); неверное значение — по умолчанию. */
export function timeoutsFromEnv(env = process.env) {
  return { call: positive(env.OQ_TIMEOUT_MS, TIMEOUT_MS), list: positive(env.OQ_LIST_TIMEOUT_MS, LIST_TIMEOUT_MS) };
}

/** Чтение коллекции целиком: полный /changes (без since) и GET /db/<коллекция> без id. */
export function isListRead(method, path) {
  if (method !== 'GET') return false;
  const [p, q = ''] = path.split('?');
  if (p === '/changes') return !new URLSearchParams(q).has('since');
  return /^\/db\/(?:checks|items|work)$/.test(p);
}

/**
 * Тело ответа 2xx как JSON. Оборванное (таймаут, разрыв) или не-JSON тело — ошибка без status: вызывающий
 * (delta.mjs transient) считает её временным сбоем и повторяет позже, а не принимает пустой ответ за данные.
 */
export async function bodyJson(res, timeoutMs) {
  if (res.status === 204 || res.status === 205) return {};
  try {
    return await res.json();
  } catch (e) {
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `не дочитан за ${Math.round(timeoutMs / 1000)} с`
      : `оборван или не JSON: ${e?.message || e}`;
    throw new Error(`ответ консоли ${why}`, { cause: e });
  }
}

/** Запрос к API: ошибка HTTP — исключение с полем status и текстом консоли; тело 2xx — bodyJson. */
export async function request({ base, token, method, path, body, timeouts, fetchFn = fetch }) {
  const ms = isListRead(method, path) ? timeouts.list : timeouts.call;
  const res = await fetchFn(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  }
  return bodyJson(res, ms);
}
