// Отбор и страницы oq_list — чистые функции без сети: фильтры, offset/next_offset и потолок размера ответа.
// На 30.10 в checks 504 документа, а ответ вмещал 83: ответы владельца старше этих 83 агенту не были видны вовсе.

// Ответ инструмента — не больше OUT_MAX символов. Список урезается по документам, а не по символам: обрезанный
// посередине JSON клиенты не разбирают (строки «Хода работ» несут списки карточек досок).
export const OUT_MAX = 95_000;
export const LIMIT_MAX = 500;
const BRIEF_TEXT = 200;
// Отметки времени в данных документов: checks — ответ и записи агента, items — added, work — факт начала и конца.
const TIME_FIELDS = ['at', 'ownerAt', 'agentAt', 'blockedAt', 'added', 'start', 'end'];

/** Последняя отметка времени документа; NaN — отметок нет. */
function lastTime(data) {
  let max = NaN;
  for (const k of TIME_FIELDS) {
    const t = typeof data[k] === 'string' ? Date.parse(data[k]) : NaN;
    if (!Number.isNaN(t) && !(max >= t)) max = t;
  }
  return max;
}

/**
 * Владелец ответил (done или choice), а агент после ответа ничего не записал. Отметки — серверные, как в open-rule.ts
 * консоли: ownerAt — сохранение ответа (у старых документов — at), agentAt — последняя запись агента.
 */
export function ownerAnswerUnread(c) {
  if (!c || !(c.done || c.choice)) return false;
  const agentAt = typeof c.agentAt === 'string' ? Date.parse(c.agentAt) : NaN;
  if (Number.isNaN(agentAt)) return true;
  const answeredAt = Date.parse(typeof c.ownerAt === 'string' ? c.ownerAt : c.at);
  return !Number.isNaN(answeredAt) && agentAt < answeredAt;
}

/** Чьё это поле «сессия»: items — source, work — session, checks — agentBy. */
const SESSION_FIELD = { items: 'source', work: 'session', checks: 'agentBy' };

/** Фильтры oq_list поверх документов консоли ({id, version, data}); порядок консоли сохраняется. */
export function filterDocs(collection, docs, { ids, prefix, kind, session, since, unread } = {}) {
  if (unread && collection !== 'checks') throw new Error('unread — только для checks: ответ владельца, который агент не прочёл');
  const sinceMs = since === undefined || since === '' ? NaN : Date.parse(String(since));
  if (since !== undefined && since !== '' && Number.isNaN(sinceMs)) throw new Error(`since — не дата: ${since} (YYYY-MM-DD или ISO)`);
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const sessionKey = SESSION_FIELD[collection];
  return docs.filter((d) => {
    const x = d.data || {};
    if (idSet && !idSet.has(d.id)) return false;
    if (prefix && !String(d.id).startsWith(prefix)) return false;
    if (kind && x.kind !== kind) return false;
    if (session && x[sessionKey] !== session) return false;
    if (!Number.isNaN(sinceMs) && !(lastTime(x) >= sinceMs)) return false;
    if (unread && !ownerAnswerUnread(x)) return false;
    return true;
  });
}

/** Окно списка: offset — с какого документа, limit — сколько (1…LIMIT_MAX, по умолчанию 50). */
export function pageList(list, { offset, limit } = {}) {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const n = limit === undefined ? 50 : Math.min(Math.max(1, Math.floor(Number(limit) || 1)), LIMIT_MAX);
  return { from, docs: list.slice(from, from + n) };
}

/** brief: строки длиннее BRIEF_TEXT — начало и длина рядом (<поле>Len); целиком — oq_get. */
export function briefDoc(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'string' && v.length > BRIEF_TEXT) {
      out[k] = `${v.slice(0, BRIEF_TEXT)}…`;
      out[`${k}Len`] = v.length;
    } else out[k] = v;
  }
  return out;
}

/**
 * Снимки коллекций для обхода страницами. Первая страница (offset 0) читает консоль и кладёт снимок; следующие
 * (offset > 0) берут снимок с тем же asOf — или последний, если asOf не передан, — пока не истёк ttl. Так next_offset
 * идёт по одному списку: вставка или удаление между страницами ничего не сдвигает. И обход 500 документов — один GET
 * консоли, а не по одному на страницу (линза GLM «ресурсы», карточка A). На ключ — не больше perKey снимков: хаб
 * отдаёт один процесс нескольким сессиям, чужой обход не должен вытеснить ваш.
 */
export function snapshots(ttlMs, { now = Date.now, perKey = 2 } = {}) {
  const store = new Map();
  return async function read(key, load, { reuse = false, asOf } = {}) {
    const t = now();
    for (const [k, list] of store) {
      const live = list.filter((s) => t - s.at <= ttlMs);
      if (live.length) store.set(k, live); else store.delete(k);
    }
    const live = store.get(key) || [];
    const want = asOf === undefined || asOf === '' ? NaN : Date.parse(String(asOf));
    const hit = reuse ? (Number.isNaN(want) ? live[0] : live.find((s) => s.at === want)) : undefined;
    if (hit) return { value: hit.value, at: hit.at, reused: true };
    const value = await load();
    // asOf — ключ снимка: два чтения в одну миллисекунду не должны получить один asOf.
    let at = t;
    while (live.some((s) => s.at === at)) at += 1;
    store.set(key, [{ at, value }, ...live].slice(0, perKey));
    return { value, at, reused: false };
  };
}

/**
 * Ответ oq_list. total — документов после фильтров; offset — начало окна (если не 0); next_offset — откуда продолжить,
 * пока документы остались (за limit или за потолком размера). shown и truncated — только когда окно урезал потолок
 * размера, а не limit. Документ больше потолка целиком не влезет ни в какое окно: его id — в oversized, next_offset
 * шагает дальше, сам документ — через oq_get.
 */
export function fitList(total, docs, from = 0, extra = {}) {
  const shape = (k) => {
    const oversized = k === 0 && docs.length > 0;
    const next = from + (oversized ? 1 : k);
    return {
      total,
      ...(from ? { offset: from } : {}),
      ...(k < docs.length ? { shown: k, truncated: true } : {}),
      ...(oversized ? { oversized: [docs[0].id] } : {}),
      ...(next < total ? { next_offset: next } : {}),
      ...extra,
      docs: docs.slice(0, k),
    };
  };
  let n = docs.length;
  while (n > 0 && JSON.stringify(shape(n), null, 1).length > OUT_MAX) n = Math.floor(n * 0.8);
  return shape(n);
}
