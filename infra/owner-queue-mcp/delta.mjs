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
//
// Полный список — по страницам (OPS-27; сервер — OPS-22, консоль HR #837, queue/changes-pages.ts): ?paged=1, дальше
// ?page=<next>, пока ответ несёт next. Каждая страница — около 1 МБ, а не 7,7 МБ одним телом: на медленной сети ответ не
// упирается в таймаут, консоль не собирает весь список в памяти. Курсор один на все страницы, зеркало заменяется только
// после последней. Консоль без страниц параметр не знает и отдаёт весь список одним ответом без next — это одна страница.

export const DELTA_COLS = ['checks', 'items', 'work'];
export const FULL_EVERY_MS = 12 * 3600_000;
export const BACKOFF_MS = 30 * 60_000;
export const RETRY_MS = 60_000;
/**
 * Потолок страниц одного полного списка — на весь full(), вместе с повтором после 410. Потолок коллекции консоли
 * (list.ts) — 10 000 документов и 16 МБ, страница — 1 МБ: при документах много меньше 1 МБ три коллекции дают около
 * 48 страниц; крупные документы (до 48 КБ, store.ts) и рост лимитов сервера дают больше. На проде 24.11 — 7 страниц по
 * ~1,1 МБ (3850 документов, 7,7 МБ одним ответом). Потолок взят с запасом: консоль, которая отдаёт next по кругу,
 * останавливает на 2-й странице проверка «страница без новых документов», а не он.
 */
export const MAX_PAGES = 200;

/**
 * Сбой, который пройдёт сам: 5xx, 429, сеть или недочитанное тело (у ошибок fetch и http.mjs bodyJson нет status, OPS-79);
 * ответ не по контракту — не он. transient: true — сбой, который пройдёт сам при любом status (второй 410 подряд).
 */
const transient = (e) => e?.transient === true || (!e?.contract && (e?.status === undefined ? true : e.status >= 500 || e.status === 429));
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

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Проход полного списка прерван устаревшим токеном страницы — начать с первой. */
const RESTART = Symbol('restart');
/**
 * Документ консоли — объект со строковым id и объектом data. Иначе он остался бы в зеркале, и каждый oq_list items
 * падал бы на d.data.kind до полного списка через 12 ч (линза Claude #380, NB1); прежний путь выздоравливал сразу.
 */
const docEntry = (d, where) => {
  if (!isObj(d) || typeof d.id !== 'string' || !isObj(d.data)) throw contractError(`${where}: документ без строкового id или объекта data`);
  return [d.id, d];
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

  /**
   * Один проход по страницам. Коллекция приходит на страницах, где есть её документы, и на той, где она кончилась
   * (там же потолок truncated); документы склеиваются по порядку страниц, повтор id — последняя версия.
   * Токен страницы устарел (410: консоль перезапущена между страницами) — RESTART, если можно.
   */
  async function fullPass(mayRestart, budget) {
    const docs = Object.fromEntries(cols.map((col) => [col, new Map()]));
    const meta = Object.fromEntries(cols.map((col) => [col, {}]));
    const seen = new Set();
    let cursor;
    let next;
    for (let page = 1; ; page++) {
      if (budget.pages <= 0) throw contractError(`полный список длиннее ${MAX_PAGES} страниц`);
      budget.pages -= 1;
      let j;
      try {
        j = await get(next === undefined ? `${base}&paged=1` : `${base}&page=${encodeURIComponent(next)}`);
      } catch (e) {
        // 410 — метка запуска консоли в токене устарела (OPS-70): повтор с первой страницы поможет. 400 — токен
        // отвергнут по форме. Стойкий 400 (токен портится по пути) повтор не лечит, а удваивает трафик — это обычная
        // ветка ошибки. Выкатка со сменой формата токена посреди прохода тоже даст 400 и паузу 30 мин — принятая цена:
        // такая выкатка редка, а стойкий 400 качал бы два прохода каждые 30 мин.
        if (next !== undefined && e?.status === 410) {
          if (!mayRestart) throw Object.assign(new Error(`страница ${page} снова устарела (консоль перезапущена дважды за проход)`), { transient: true });
          log(`страница ${page} полного списка устарела (консоль перезапущена) — повтор с первой`);
          return RESTART;
        }
        throw e;
      }
      next = parsed(() => {
        if (j?.full !== true || typeof j.cursor !== 'string' || !isObj(j.collections)) throw contractError('ответ без full, cursor и collections');
        if (cursor === undefined) cursor = j.cursor;
        else if (j.cursor !== cursor) throw contractError(`страница ${page} полного списка — с другим курсором`);
        if (j.next !== undefined && (typeof j.next !== 'string' || j.next === '')) throw contractError('next — не непустая строка');
        let added = 0;
        for (const col of cols) {
          const c = j.collections[col];
          if (c === undefined) continue;
          if (!Array.isArray(c?.docs)) throw contractError(`в полном списке нет коллекции ${col}`);
          for (const d of c.docs) {
            const [id, doc] = docEntry(d, `полный список ${col}`);
            if (!docs[col].has(id)) added += 1;
            docs[col].set(id, doc);
          }
          seen.add(col);
          if (c.truncated === true) meta[col] = { truncated: true, total: c.total, limit: c.limit };
        }
        // Страница с next всегда несёт хотя бы один новый документ (сервер идёт по ключу (updated_at, id) вниз):
        // иначе консоль отдаёт next по кругу, и без этой проверки клиент качал бы страницы до MAX_PAGES.
        if (j.next !== undefined && added === 0) throw contractError(`страница ${page} полного списка без новых документов, но с next`);
        return j.next;
      });
      if (next === undefined) break;
    }
    parsed(() => {
      for (const col of cols) if (!seen.has(col)) throw contractError(`в полном списке нет коллекции ${col}`);
    });
    st = { cursor, fullAt: now(), docs, meta };
    return null;
  }

  /**
   * Полный список; токен страницы устарел (410) — один повтор с первой страницы. Второй 410 подряд — сбой, который
   * пройдёт сам (выкатка с двумя перезапусками): повтор через RETRY_MS, а не пауза BACKOFF_MS — зеркало и курсор целы.
   */
  async function full() {
    const budget = { pages: MAX_PAGES };
    if ((await fullPass(true, budget)) === RESTART) await fullPass(false, budget);
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
        // Консоль отдаёт оба списка у каждой коллекции (changes.ts, CollectionChanges): иное — нарушение контракта (NB1, NB2).
        const ch = j.changes[col];
        if (!isObj(ch)) throw contractError(`в дельте нет коллекции ${col}`);
        if (!Array.isArray(ch.removed) || !ch.removed.every((id) => typeof id === 'string')) throw contractError(`дельта ${col}: removed — не список строк`);
        if (!Array.isArray(ch.docs)) throw contractError(`дельта ${col}: docs — не список`);
        return { col, removed: [...ch.removed], docs: ch.docs.map((d) => docEntry(d, `дельта ${col}`)) };
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
