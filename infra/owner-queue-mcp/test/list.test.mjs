// Отбор и страницы oq_list (list.mjs): фильтры, окно offset/limit, next_offset и потолок размера ответа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUT_MAX, briefDoc, filterDocs, fitEvents, fitList, ownerAnswerUnread, pageList, replyText, snapshots } from '../list.mjs';

const check = (id, data) => ({ id, version: 1, data });

test('ownerAnswerUnread: ответ без записи агента или запись раньше ответа — не прочитан; без ответа — нет', () => {
  assert.equal(ownerAnswerUnread({ done: true, at: '2026-10-30T01:00:00Z' }), true);
  assert.equal(ownerAnswerUnread({ choice: { v: 'a' }, ownerAt: '2026-10-30T02:00:00Z', agentAt: '2026-10-30T01:00:00Z' }), true);
  assert.equal(ownerAnswerUnread({ done: true, ownerAt: '2026-10-30T01:00:00Z', agentAt: '2026-10-30T02:00:00Z' }), false);
  // ownerAt — серверная отметка ответа: at с часов устройства владельца её не перебивает.
  assert.equal(ownerAnswerUnread({ done: true, at: '2026-10-30T03:00:00Z', ownerAt: '2026-10-30T01:00:00Z', agentAt: '2026-10-30T02:00:00Z' }), false);
  assert.equal(ownerAnswerUnread({ done: false, agentStatus: 'doing' }), false);
  assert.equal(ownerAnswerUnread({ choice: null }), false);
  assert.equal(ownerAnswerUnread(undefined), false);
});

test('filterDocs: ids, prefix, kind, session, since, unread — каждый сужает, порядок консоли сохраняется', () => {
  const checks = [
    check('d-a', { choice: { v: 1 }, ownerAt: '2026-10-30T02:00:00Z', agentAt: '2026-10-30T01:00:00Z', agentBy: 'bb' }),
    check('s-b', { done: true, ownerAt: '2026-10-29T02:00:00Z', agentAt: '2026-10-29T03:00:00Z', agentBy: 'e1' }),
    check('d-c', { agentStatus: 'planned', agentAt: '2026-10-20T00:00:00Z', agentBy: 'bb' }),
  ];
  const ids = (list) => list.map((d) => d.id);
  assert.deepEqual(ids(filterDocs('checks', checks, {})), ['d-a', 's-b', 'd-c']);
  assert.deepEqual(ids(filterDocs('checks', checks, { prefix: 'd-' })), ['d-a', 'd-c']);
  assert.deepEqual(ids(filterDocs('checks', checks, { ids: ['d-c', 'нет'] })), ['d-c']);
  assert.deepEqual(ids(filterDocs('checks', checks, { session: 'bb' })), ['d-a', 'd-c']);
  assert.deepEqual(ids(filterDocs('checks', checks, { since: '2026-10-29' })), ['d-a', 's-b']);
  assert.deepEqual(ids(filterDocs('checks', checks, { unread: true })), ['d-a']);
  assert.deepEqual(ids(filterDocs('checks', checks, { unread: true, session: 'e1' })), []);

  const items = [check('d-x', { kind: 'decision', source: 'bb', added: '2026-10-30' }), check('i-y', { kind: 'inbox', source: 'bot', added: '2026-10-28' })];
  assert.deepEqual(ids(filterDocs('items', items, { kind: 'inbox' })), ['i-y']);
  assert.deepEqual(ids(filterDocs('items', items, { session: 'bb', since: '2026-10-30' })), ['d-x']);
  // Документ без отметок времени под since не проходит: «не раньше» о нём сказать нельзя.
  assert.deepEqual(ids(filterDocs('work', [check('w-n', { title: 'без дат' })], { since: '2026-01-01' })), []);
});

test('filterDocs: неверный since и unread вне checks — ошибка с объяснением, а не пустой список', () => {
  assert.throws(() => filterDocs('checks', [], { since: 'вчера' }), /since — не дата/);
  assert.throws(() => filterDocs('items', [], { unread: true }), /только для checks/);
});

test('pageList: offset и limit (1…500, по умолчанию 50); offset за концом — пустое окно', () => {
  const list = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(pageList(list, {}), { from: 0, docs: list.slice(0, 50) });
  assert.deepEqual(pageList(list, { offset: 100, limit: 50 }).docs, list.slice(100));
  assert.equal(pageList(list, { limit: 10_000 }).docs.length, 120);
  assert.equal(pageList(list, { limit: 0 }).docs.length, 1);
  assert.equal(pageList(list, { offset: -5 }).from, 0);
  assert.deepEqual(pageList(list, { offset: 500 }).docs, []);
});

test('fitList: next_offset — пока документы остались, за limit или за потолком размера; последнее окно без него', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}` }));
  assert.deepEqual(fitList(10, docs), { total: 10, docs });
  assert.deepEqual(fitList(30, docs, 10), { total: 30, offset: 10, next_offset: 20, docs });
  assert.deepEqual(fitList(30, docs, 20), { total: 30, offset: 20, docs });

  const big = Array.from({ length: 40 }, (_, i) => ({ id: `b-${i}`, note: 'x'.repeat(5_000) }));
  const cut = fitList(40, big);
  assert.ok(JSON.stringify(cut, null, 1).length <= OUT_MAX);
  assert.equal(cut.truncated, true);
  assert.equal(cut.next_offset, cut.shown);
  assert.deepEqual(cut.docs.map((d) => d.id), big.slice(0, cut.shown).map((d) => d.id));
});

test('fitList: документ больше потолка — oversized с его id и шаг дальше, а не вечный next_offset на месте', () => {
  const huge = [{ id: 'w-huge', note: 'x'.repeat(OUT_MAX + 10) }, { id: 'w-next' }];
  const out = fitList(2, huge);
  assert.deepEqual(out.docs, []);
  assert.deepEqual(out.oversized, ['w-huge']);
  assert.equal(out.next_offset, 1);
});

test('snapshots: продолжение — тот же снимок (по asOf или последний), offset 0 и истёкший ttl — новое чтение', async () => {
  let clock = 1_000;
  let loads = 0;
  const read = snapshots(100, { now: () => clock, perKey: 2 });
  const load = async () => { loads += 1; return `v${loads}`; };

  const first = await read('k', load);
  assert.deepEqual([first.value, first.reused, loads], ['v1', false, 1]);
  assert.equal((await read('k', load, { reuse: true })).value, 'v1');
  assert.equal(loads, 1, 'продолжение обхода консоль не читает');

  // Чужой обход начался в ту же миллисекунду — у снимков разные asOf, ваш берётся по своему.
  const other = await read('k', load);
  assert.notEqual(other.at, first.at);
  const mine = await read('k', load, { reuse: true, asOf: new Date(first.at).toISOString() });
  assert.deepEqual([mine.value, mine.reused], ['v1', true]);
  assert.equal((await read('k', load, { reuse: true })).value, 'v2', 'без asOf — последний снимок');

  clock += 101;
  const late = await read('k', load, { reuse: true, asOf: new Date(first.at).toISOString() });
  assert.deepEqual([late.value, late.reused], ['v3', false], 'истёк — перечитан, а не отдан старый');
});

test('briefDoc: длинные строки — начало и длина, короткие и не строки — как есть', () => {
  const long = 'я'.repeat(250);
  assert.deepEqual(briefDoc({ id: 'c', note: long, done: true, at: '2026-10-30' }),
    { id: 'c', note: `${long.slice(0, 200)}…`, noteLen: 250, done: true, at: '2026-10-30' });
});

test('fitEvents: события целиком, новые первыми; не влезли — shown, truncated, подсказка; ответ — валидный JSON', () => {
  const small = [{ at: 2, actor: 'a', action: 'put', after: { note: 'x' } }, { at: 1, actor: 'a', action: 'put', after: null }];
  assert.deepEqual(fitEvents(small), { total: 2, events: small });
  // 50 событий по 48 КБ — как в находке «Контроля» #239: раньше slice(0, 100 000) рвал JSON посреди события.
  const big = Array.from({ length: 50 }, (_, i) => ({ at: 50 - i, actor: 's', action: 'patch', after: { body: 'я'.repeat(48_000) } }));
  const r = fitEvents(big);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 50);
  assert.ok(r.shown >= 1 && r.shown < 50);
  assert.deepEqual(r.events, big.slice(0, r.shown));
  assert.ok(JSON.stringify(r, null, 1).length <= OUT_MAX);
  assert.match(r.hint, /brief: true/);
  const b = fitEvents(big, { brief: true });
  assert.equal(b.truncated, undefined);
  assert.equal(b.events.length, 50);
  assert.equal(b.events[0].after.bodyLen, 48_000);
  assert.ok(b.events[0].after.body.length <= 201);
});

test('fitEvents: одно событие больше потолка — shown 0, без обрыва; brief его показывает', () => {
  const huge = [{ at: 1, actor: 's', action: 'put', after: { body: 'x'.repeat(OUT_MAX + 10) } }];
  assert.deepEqual(fitEvents(huge).events, []);
  assert.equal(fitEvents(huge).shown, 0);
  assert.equal(fitEvents(huge, { brief: true }).events.length, 1);
});

test('replyText: JSON целиком или ошибка с размером — никогда не обрезанный JSON', () => {
  assert.deepEqual(replyText({ a: 1 }), { text: JSON.stringify({ a: 1 }, null, 1) });
  const r = replyText({ s: 'x'.repeat(200) }, 100);
  assert.equal(r.isError, true);
  assert.match(r.text, /больше потолка 100/);
  assert.deepEqual(replyText(undefined), { text: 'null' });
});
