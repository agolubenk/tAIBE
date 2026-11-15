// Дельта-зеркало oq_list (карточка HR Q-38): полный список один раз, дальше только изменения; 410, старая консоль и
// сбой — без потери данных и без шторма полных списков.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MS, FULL_EVERY_MS, RETRY_MS, createDeltaMirror } from '../delta.mjs';

/**
 * Поддельная консоль по контракту /changes (queue/changes.ts HR): без since — full, cursor и collections; с since —
 * changes {docs, removed} и новый cursor; курсор старой загрузки — 410. mode 'old' — маршрута нет (404).
 */
function fakeConsole({ mode = 'ok', truncatedWork = false, cols = 'checks,items,work' } = {}) {
  const c = { boot: 'b1', seq: 0, cols: { checks: new Map(), items: new Map(), work: new Map() }, log: [], reqs: [], bytes: [], mode };
  const put = (col, id, data, at) => {
    c.seq += 1;
    c.cols[col].set(id, { id, version: 1, data, updatedAt: at ?? c.seq, product: 'hr-helper' });
    c.log.push({ seq: c.seq, col, id });
  };
  const del = (col, id) => { c.seq += 1; c.cols[col].delete(id); c.log.push({ seq: c.seq, col, id }); };
  const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
  const get = async (path) => {
    c.reqs.push(path);
    if (c.mode === 'old') fail(404, 'Not Found');
    if (c.mode === 'down') fail(503, 'Service Unavailable');
    const u = new URL(path, 'http://x');
    assert.equal(u.pathname, '/changes');
    assert.equal(u.searchParams.get('col'), cols);
    const want = cols.split(',');
    const since = u.searchParams.get('since');
    let out;
    if (!since) {
      const collections = {};
      for (const [col, m] of Object.entries(c.cols).filter(([k]) => want.includes(k))) {
        collections[col] = { docs: [...m.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          ...(col === 'work' && truncatedWork ? { truncated: true, total: 7, limit: m.size } : {}) };
      }
      out = { full: true, cursor: `${c.boot}.${c.seq}`, collections };
    } else {
      const [boot, n] = since.split('.');
      if (boot !== c.boot) fail(410, 'курсор другой загрузки консоли');
      const changes = {};
      for (const col of want) {
        const ids = [...new Set(c.log.filter((e) => e.seq > Number(n) && e.col === col).map((e) => e.id))];
        changes[col] = { docs: ids.filter((id) => c.cols[col].has(id)).map((id) => c.cols[col].get(id)), removed: ids.filter((id) => !c.cols[col].has(id)) };
      }
      out = { cursor: `${c.boot}.${c.seq}`, changes };
    }
    c.bytes.push(Buffer.byteLength(JSON.stringify(out)));
    return JSON.parse(JSON.stringify(out));
  };
  return { c, put, del, get, restart: () => { c.boot = `b${Number(c.boot.slice(1)) + 1}`; } };
}

function rig(opts = {}) {
  const f = fakeConsole(opts);
  let t = 1_000_000;
  const logs = [];
  const m = createDeltaMirror({ get: f.get, now: () => t, log: (s) => logs.push(s), ...(opts.cols ? { cols: opts.cols.split(',') } : {}) });
  return { ...f, m, logs, tick: (ms) => { t += ms; } };
}

test('полный список один раз, дальше только изменения: новый, изменённый и удалённый документ; порядок — свежие первыми', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  r.put('items', 'd-2', { title: 'два' });
  r.put('items', 'd-4', { title: 'четыре' });
  r.put('checks', 'd-1', { done: true });
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-4', 'd-2', 'd-1']);
  r.put('items', 'd-3', { title: 'три' });
  r.put('items', 'd-1', { title: 'один, правка' });
  r.del('items', 'd-4');
  const items = (await r.m.list('items')).docs;
  // Порядок вставки в зеркало был бы d-2, d-1, d-3 — порядок консоли другой: по свежести.
  assert.deepEqual(items.map((d) => d.id), ['d-1', 'd-3', 'd-2'], 'd-1 изменён последним — первый; d-4 удалён');
  assert.equal(items[0].data.title, 'один, правка');
  assert.deepEqual((await r.m.list('checks')).docs.map((d) => d.id), ['d-1']);
  assert.equal(r.c.reqs.filter((p) => !p.includes('since=')).length, 1, 'полный список — один раз');
  assert.equal(r.c.reqs.length, 3);
});

test('приёмка карточки: опрос без изменений весит меньше 50 КБ при коллекции в 3 МБ', async () => {
  const r = rig();
  for (let i = 0; i < 1500; i++) r.put('items', `d-${i}`, { title: `пункт ${i}`, body: 'т'.repeat(1_000) });
  await r.m.list('items');
  assert.ok(r.c.bytes[0] > 3_000_000, `полный список ${r.c.bytes[0]} байт`);
  for (let i = 0; i < 5; i++) await r.m.list('items');
  for (const b of r.c.bytes.slice(1)) assert.ok(b < 50_000, `опрос без изменений — ${b} байт`);
  assert.ok(Math.max(...r.c.bytes.slice(1)) < 200, 'на деле — сотня байт: курсор и пустые списки');
});

test('курсор устарел (перезапуск консоли) — 410 и один полный список, данные не теряются', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  await r.m.list('items');
  r.restart();
  r.put('items', 'd-2', { title: 'два' });
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-2', 'd-1']);
  assert.deepEqual(r.c.reqs.map((p) => p.includes('since=')), [false, true, false], 'дельта → 410 → полный');
  assert.equal(r.logs.length, 0, '410 — штатно, без строки в журнал');
});

test('старая консоль без /changes (404) — null: oq_list читает прежним путём; повтор дельты — через 30 мин, не на каждом вызове', async () => {
  const r = rig({ mode: 'old' });
  assert.equal(await r.m.list('items'), null);
  assert.match(r.logs[0], /дельта \/changes не работает \(Not Found\) — 30 мин/);
  r.tick(BACKOFF_MS - 1);
  assert.equal(await r.m.list('checks'), null);
  assert.equal(r.c.reqs.length, 1, 'пока пауза — консоль не дёргаем');
  r.c.mode = 'ok';
  r.put('items', 'd-1', { title: 'один' });
  r.tick(1);
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-1'], 'пауза кончилась — снова дельта');
});

test('выкатка консоли посреди работы (503) — прежний путь, зеркало и курсор целы; через минуту — дельта, а не полный список (линза Claude #353, п. 1)', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  await r.m.list('items');
  r.c.mode = 'down';
  assert.equal(await r.m.list('items'), null);
  assert.match(r.logs[0], /повтор дельты через 60 с/);
  r.tick(RETRY_MS - 1);
  assert.equal(await r.m.list('items'), null);
  assert.equal(r.c.reqs.length, 2, 'до повтора консоль не дёргаем');
  r.c.mode = 'ok';
  r.put('items', 'd-2', { title: 'два' });
  r.tick(1);
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-2', 'd-1']);
  assert.equal(r.c.reqs.at(-1).includes('since='), true, 'после выкатки — дельта от курсора');
  assert.equal(r.c.reqs.filter((p) => !p.includes('since=')).length, 1, 'полный список — один раз за всё время');
});

test('сеть (ошибка без status) — как выкатка: повтор через минуту; консоль за это время перезапустилась — 410 и один полный список', async () => {
  const f = fakeConsole();
  f.put('items', 'd-1', { title: 'один' });
  let t = 1_000_000;
  let net = false;
  const logs = [];
  const m = createDeltaMirror({ get: async (p) => { if (net) throw new TypeError('fetch failed'); return f.get(p); }, now: () => t, log: (s) => logs.push(s) });
  await m.list('items');
  net = true;
  assert.equal(await m.list('items'), null);
  assert.match(logs[0], /fetch failed.*повтор дельты через 60 с/);
  net = false;
  f.restart();
  f.put('items', 'd-2', { title: 'два' });
  t += RETRY_MS;
  assert.deepEqual((await m.list('items')).docs.map((d) => d.id), ['d-2', 'd-1']);
  assert.deepEqual(f.c.reqs.slice(-2).map((p) => p.includes('since=')), [true, false], 'дельта от курсора → 410 → полный список');
});

test('ответ не по контракту и 4xx (кроме 410, 429) — зеркало сброшено, пауза 30 мин, потом свежий полный список', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  await r.m.list('items');
  r.c.mode = 'old';
  assert.equal(await r.m.list('items'), null);
  assert.match(r.logs[0], /30 мин прежний полный список/);
  r.c.mode = 'ok';
  r.tick(RETRY_MS);
  assert.equal(await r.m.list('items'), null, 'не минутный повтор: 404 сам не пройдёт');
  r.tick(BACKOFF_MS);
  await r.m.list('items');
  assert.equal(r.c.reqs.at(-1).includes('since='), false, 'после 404 — полный список, курсор сброшен');
});

test('одновременные вызовы — один запрос к консоли; полный список ещё и раз в 12 ч', async () => {
  const r = rig();
  r.put('work', 'w-1', { title: 'строка' });
  const [a, b] = await Promise.all([r.m.list('items'), r.m.list('work')]);
  assert.equal(r.c.reqs.length, 1);
  assert.deepEqual([a.docs.length, b.docs.length], [0, 1]);
  r.tick(FULL_EVERY_MS);
  await r.m.list('work');
  assert.equal(r.c.reqs.at(-1).includes('since='), false);
});

test('потолок консоли у коллекции (truncated, total, limit) — сохраняется, как у GET /db/:col; чужая коллекция — null', async () => {
  const r = rig({ truncatedWork: true });
  r.put('work', 'w-1', { title: 'строка' });
  r.put('work', 'w-2', { title: 'строка 2' });
  assert.deepEqual(await r.m.list('work').then(({ docs: _d, ...meta }) => meta), { truncated: true, total: 7, limit: 2 });
  assert.equal(await r.m.list('history'), null);
});

test('cols — только нужные коллекции (автопередача: checks и items, линза «Контроля» #353, п. 2)', async () => {
  const r = rig({ cols: 'checks,items' });
  r.put('items', 'i-1', { kind: 'inbox' });
  r.put('work', 'w-1', { title: 'строка' });
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['i-1']);
  assert.equal(await r.m.list('work'), null, 'work не держим — прежний путь');
  r.put('work', 'w-2', { title: 'ещё' });
  await r.m.list('checks');
  assert.equal(r.c.bytes.at(-1) < 120, true, 'изменения work в дельту не попадают');
});

test('порядок при равном updatedAt — по id убыванию, как orderBy(desc(updatedAt), desc(id)) консоли (#344)', async () => {
  const r = rig();
  for (const id of ['d-a', 'd-c', 'd-b']) r.put('items', id, { title: id }, 500);
  r.put('items', 'd-z', { title: 'старый' }, 100);
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-c', 'd-b', 'd-a', 'd-z']);
});
