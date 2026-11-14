// Дельта-зеркало коллекций очереди для oq_list (карточка HR Q-38 abytrgnm): полный список — один раз за процесс MCP,
// дальше GET /changes?since=<курсор> отдаёт только изменённые документы и удалённые id (OPS-50, консоль HR #623).
// До этого каждый oq_list без open_only тянул всю коллекцию: items больше 3,4 МБ без сжатия (замер «Контроля»
// 14.11), за сутки — 114 вызовов items, 108 checks и 47 work по журналам сессий.
//
// Курсор устарел (перезапуск консоли, больше 500 изменений) — 410 и полный список. /changes нет или не отвечает
// (старая консоль, сеть) — null: oq_list читает прежним путём, а дельта отдыхает BACKOFF_MS. Полный список ещё и раз в
// FULL_EVERY_MS — страховка от правки базы консоли мимо журнала событий (как у Нерва, eval/nerve/sources.py).

export const DELTA_COLS = ['checks', 'items', 'work'];
export const FULL_EVERY_MS = 12 * 3600_000;
export const BACKOFF_MS = 30 * 60_000;

/** Порядок консоли (queue/list.ts listDocs): самые свежие первыми — по updatedAt. */
const byFresh = (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);

/**
 * get(path) → JSON ответа консоли; ошибка HTTP — исключение с полем status (как apiWith в server.mjs).
 * list(col) → { docs, truncated?, total?, limit? } в форме GET /db/:col, или null — читать прежним путём.
 */
export function createDeltaMirror({ get, now = Date.now, log = () => {}, fullEveryMs = FULL_EVERY_MS, backoffMs = BACKOFF_MS }) {
  const base = `/changes?col=${DELTA_COLS.join(',')}`;
  let st = null; // { cursor, fullAt, docs: { col: Map<id, doc> }, meta: { col: { truncated, total, limit } } }
  let restUntil = 0;
  let inflight = null;

  async function full() {
    const j = await get(base);
    if (j?.full !== true || typeof j.cursor !== 'string' || !j.collections) throw new Error('ответ без full, cursor и collections');
    const docs = {};
    const meta = {};
    for (const col of DELTA_COLS) {
      const c = j.collections[col];
      if (!Array.isArray(c?.docs)) throw new Error(`в полном списке нет коллекции ${col}`);
      docs[col] = new Map(c.docs.map((d) => [d.id, d]));
      meta[col] = c.truncated === true ? { truncated: true, total: c.total, limit: c.limit } : {};
    }
    st = { cursor: j.cursor, fullAt: now(), docs, meta };
  }

  async function delta() {
    let j;
    try {
      j = await get(`${base}&since=${encodeURIComponent(st.cursor)}`);
    } catch (e) {
      if (e?.status === 410) return full();
      throw e;
    }
    if (typeof j?.cursor !== 'string' || !j.changes) throw new Error('ответ без cursor и changes');
    for (const col of DELTA_COLS) {
      const ch = j.changes[col];
      if (!ch) throw new Error(`в дельте нет коллекции ${col}`);
      for (const id of ch.removed || []) st.docs[col].delete(id);
      for (const d of ch.docs || []) st.docs[col].set(d.id, d);
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
    if (!DELTA_COLS.includes(col) || now() < restUntil) return null;
    try {
      await sync();
    } catch (e) {
      st = null;
      restUntil = now() + backoffMs;
      log(`дельта /changes не работает (${e?.message || e}) — ${Math.round(backoffMs / 60_000)} мин прежний полный список`);
      return null;
    }
    return { docs: [...st.docs[col].values()].sort(byFresh), ...st.meta[col] };
  }

  return { list };
}
