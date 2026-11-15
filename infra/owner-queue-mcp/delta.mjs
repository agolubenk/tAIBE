// Дельта-зеркало коллекций очереди для oq_list (карточка HR Q-38 abytrgnm): полный список — один раз за процесс MCP,
// дальше GET /changes?since=<курсор> отдаёт только изменённые документы и удалённые id (OPS-50, консоль HR #623).
// До этого каждый oq_list без open_only тянул всю коллекцию: items больше 3,4 МБ без сжатия (замер «Контроля»
// 14.11), за сутки — 114 вызовов items, 108 checks и 47 work по журналам сессий.
//
// Курсор устарел (перезапуск консоли, больше 500 изменений) — 410 и полный список. /changes нет (старая консоль, 4xx)
// или ответ не по контракту — null: oq_list читает прежним путём, зеркало сброшено, дельта отдыхает BACKOFF_MS.
// Консоль временно не отвечает (5xx, 429, сеть — окно выкатки) — null, но зеркало и курсор целы, повтор через
// RETRY_MS, а не 30 мин прежнего пути (линза Claude #353, п. 1). Пока курсор несёт метку запуска консоли (OPS-70),
// после выкатки с перезапуском это 410 и один полный список; без перезапуска — дельта от курсора.
// Полный список ещё и раз в FULL_EVERY_MS — страховка от правки базы консоли мимо журнала событий (как у Нерва).

export const DELTA_COLS = ['checks', 'items', 'work'];
export const FULL_EVERY_MS = 12 * 3600_000;
export const BACKOFF_MS = 30 * 60_000;
export const RETRY_MS = 60_000;

/** Сбой, который пройдёт сам: 5xx, 429 или сеть (у ошибки fetch нет status); ответ не по контракту — не он. */
const transient = (e) => !e?.contract && (e?.status === undefined ? true : e.status >= 500 || e.status === 429);
const contractError = (msg) => Object.assign(new Error(msg), { contract: true });
/**
 * Разбор ответа, который консоль уже отдала: любая ошибка здесь — нарушение контракта (docs: 5, docs: [null] дают
 * TypeError без status), а не временный сбой — иначе без зеркала полный список уходил бы каждые 60 с (линза Claude #370, N2).
 */
const parsed = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw e?.contract ? e : contractError(`ответ не по контракту: ${e?.message || e}`);
  }
};

/** Порядок консоли (queue/list.ts listDocs, с #344): самые свежие первыми — по updatedAt, при равном — по id убыванию. */
const byFresh = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * get(path) → JSON ответа консоли; ошибка HTTP — исключение с полем status (как apiWith в server.mjs).
 * list(col) → { docs, truncated?, total?, limit? } в форме GET /db/:col, или null — читать прежним путём.
 * cols — какие коллекции держать: автопередаче хватает items и checks (линза «Контроля» #353, п. 2).
 * Потолок консоли (truncated, total, limit) — из последнего полного списка; дельта его не пересчитывает.
 */
export function createDeltaMirror({ get, cols = DELTA_COLS, now = Date.now, log = () => {}, fullEveryMs = FULL_EVERY_MS, backoffMs = BACKOFF_MS, retryMs = RETRY_MS }) {
  const base = `/changes?col=${cols.join(',')}`;
  let st = null; // { cursor, fullAt, docs: { col: Map<id, doc> }, meta: { col: { truncated, total, limit } } }
  let restUntil = 0;
  let inflight = null;

  async function full() {
    const j = await get(base);
    st = parsed(() => {
      if (j?.full !== true || typeof j.cursor !== 'string' || !j.collections) throw contractError('ответ без full, cursor и collections');
      const docs = {};
      const meta = {};
      for (const col of cols) {
        const c = j.collections[col];
        if (!Array.isArray(c?.docs)) throw contractError(`в полном списке нет коллекции ${col}`);
        docs[col] = new Map(c.docs.map((d) => [d.id, d]));
        meta[col] = c.truncated === true ? { truncated: true, total: c.total, limit: c.limit } : {};
      }
      return { cursor: j.cursor, fullAt: now(), docs, meta };
    });
  }

  async function delta() {
    let j;
    try {
      j = await get(`${base}&since=${encodeURIComponent(st.cursor)}`);
    } catch (e) {
      if (e?.status === 410) return full();
      throw e;
    }
    // Сначала вся дельта проверяется и собирается, потом применяется: ответ, сломанный посреди, не оставит зеркало
    // наполовину обновлённым со старым курсором (ошибка разбора и так сбрасывает зеркало — это вторая страховка).
    const ops = parsed(() => {
      if (typeof j?.cursor !== 'string' || !j.changes) throw contractError('ответ без cursor и changes');
      return cols.map((col) => {
        const ch = j.changes[col];
        if (!ch) throw contractError(`в дельте нет коллекции ${col}`);
        return { col, removed: [...(ch.removed || [])], docs: [...(ch.docs || [])].map((d) => [d.id, d]) };
      });
    });
    for (const { col, removed, docs } of ops) {
      for (const id of removed) st.docs[col].delete(id);
      for (const [id, d] of docs) st.docs[col].set(id, d);
    }
    st.cursor = j.cursor;
  }

  /** Одно обновление на все одновременные вызовы: два oq_list подряд не шлют два запроса. */
  function sync() {
    if (!inflight) {
      inflight = (!st || now() - st.fullAt >= fullEveryMs ? full() : delta()).finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function list(col) {
    if (!cols.includes(col) || now() < restUntil) return null;
    try {
      await sync();
    } catch (e) {
      if (transient(e)) {
        restUntil = now() + retryMs;
        log(`консоль не ответила на /changes (${e?.message || e}) — прежний путь, повтор дельты через ${Math.round(retryMs / 1000)} с`);
        return null;
      }
      st = null;
      restUntil = now() + backoffMs;
      log(`дельта /changes не работает (${e?.message || e}) — ${Math.round(backoffMs / 60_000)} мин прежний полный список`);
      return null;
    }
    return { docs: [...st.docs[col].values()].sort(byFresh), ...st.meta[col] };
  }

  return { list };
}
