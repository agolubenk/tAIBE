// Дельта-зеркало oq_list (карточка HR Q-38): полный список один раз, дальше только изменения; 410, старая консоль и
// сбой — без потери данных и без шторма полных списков.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MS, FULL_EVERY_MS, MAX_PAGES, RETRY_MS, createDeltaMirror } from '../delta.mjs';

/**
 * Поддельная консоль по контракту /changes (queue/changes.ts HR): без since — full, cursor и collections; с since —
 * changes {docs, removed} и новый cursor; курсор старой загрузки — 410. mode 'old' — маршрута нет (404).
 */
function fakeConsole({ mode = 'ok', truncatedWork = false, cols = 'checks,items,work', pageSize = 0 } = {}) {
  const c = { boot: 'b1', seq: 0, cols: { checks: new Map(), items: new Map(), work: new Map() }, log: [], reqs: [], bytes: [], mode };
  const fresh = (a, b) => b.updatedAt - a.updatedAt;
  const workCap = (col) => (col === 'work' && truncatedWork ? { truncated: true, total: 7, limit: c.cols.work.size } : {});
  /**
   * Полный список по страницам (OPS-22, queue/changes-pages.ts HR): pageSize документов на страницу, курсор первой
   * страницы — на всех, коллекция — на страницах со своими документами и на той, где кончилась (там же потолок).
   * Токен — метка запуска, курсор и позиция; токен другого запуска — 410, мусор — 400. pageSize 0 — консоль без
   * страниц: paged не знает и отдаёт весь список одним ответом.
   */
  const pagedOut = (want, page) => {
    let cur = c.seq;
    let off = 0;
    if (page !== null) {
      const m = /^([a-z0-9]+)\.(\d+)\.(\d+)$/.exec(Buffer.from(page, 'base64url').toString());
      if (!m) fail(400, 'page — токен next из прошлого ответа /changes');
      if (m[1] !== c.boot) fail(410, 'консоль перезапущена между страницами');
      cur = Number(m[2]);
      off = Number(m[3]);
    }
    const flat = [];
    const ends = [];
    for (const col of want) {
      for (const d of [...c.cols[col].values()].sort(fresh)) flat.push([col, d]);
      ends.push([col, flat.length]);
    }
    const to = Math.min(off + pageSize, flat.length);
    const collections = {};
    for (const [col, d] of flat.slice(off, to)) (collections[col] ??= { docs: [] }).docs.push(d);
    for (const [col, end] of ends) {
      if ((end > off || off === 0) && end <= to) collections[col] = { docs: collections[col]?.docs ?? [], ...workCap(col) };
    }
    const next = to < flat.length ? { next: Buffer.from(`${c.boot}.${cur}.${to}`).toString('base64url') } : {};
    return { full: true, cursor: `${c.boot}.${cur}`, collections, ...next };
  };
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
    if (c.mode === 'busy') fail(429, 'Too Many Requests');
    // Ответ пришёл (200), но вложенная форма битая: docs не массив, документ null, removed не массив.
    if (c.mode === 'badDocs') return { full: true, cursor: 'b1.0', collections: { checks: { docs: 5 }, items: { docs: [] }, work: { docs: [] } } };
    if (c.mode === 'nullDoc') return { full: true, cursor: 'b1.0', collections: { checks: { docs: [null] }, items: { docs: [] }, work: { docs: [] } } };
    if (c.mode === 'badDelta' && path.includes('since=')) return { cursor: 'b1.99', changes: { checks: { docs: [], removed: [] }, items: { docs: [{ id: 'x' }], removed: 7 }, work: { docs: [], removed: [] } } };
    // Тест задаёт битое содержимое сам: fullChecks — docs у checks в полном списке, deltaItems — changes.items дельты.
    if (c.fullChecks && !path.includes('since=')) return { full: true, cursor: 'b1.0', collections: { checks: { docs: c.fullChecks }, items: { docs: [] }, work: { docs: [] } } };
    if ('deltaItems' in c && path.includes('since=')) return { cursor: 'b1.99', changes: { checks: { docs: [], removed: [] }, items: c.deltaItems, work: { docs: [], removed: [] } } };
    const u = new URL(path, 'http://x');
    assert.equal(u.pathname, '/changes');
    assert.equal(u.searchParams.get('col'), cols);
    const want = cols.split(',');
    const since = u.searchParams.get('since');
    let out;
    const page = u.searchParams.get('page');
    if (pageSize && !since && (page !== null || u.searchParams.get('paged') === '1')) {
      out = pagedOut(want, page);
    } else if (!since) {
      const collections = {};
      for (const [col, m] of Object.entries(c.cols).filter(([k]) => want.includes(k))) {
        collections[col] = { docs: [...m.values()].sort(fresh), ...workCap(col) };
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

test('429 (консоль просит подождать) — как выкатка: зеркало и курсор целы, повтор через минуту, дальше дельта (линза Claude #370, N3)', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  await r.m.list('items');
  r.c.mode = 'busy';
  assert.equal(await r.m.list('items'), null);
  assert.match(r.logs[0], /Too Many Requests.*повтор дельты через 60 с/);
  r.c.mode = 'ok';
  r.put('items', 'd-2', { title: 'два' });
  r.tick(RETRY_MS);
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-2', 'd-1']);
  assert.equal(r.c.reqs.filter((p) => !p.includes('since=')).length, 1, 'полный список — один раз');
});

test('ответ пришёл, но вложенная форма битая (docs: 5, docs: [null]) — нарушение контракта: пауза 30 мин, а не полный список каждую минуту (линза Claude #370, N2)', async () => {
  for (const mode of ['badDocs', 'nullDoc']) {
    const r = rig({ mode });
    assert.equal(await r.m.list('items'), null, mode);
    assert.match(r.logs[0], /дельта \/changes не работает .*30 мин прежний полный список/, mode);
    for (let i = 0; i < 29; i++) { r.tick(60_000); assert.equal(await r.m.list('items'), null); }
    assert.equal(r.c.reqs.length, 1, `${mode}: за 29 мин — один запрос, а не 30 полных списков`);
  }
});

test('дельта с битой формой (removed: 7) — зеркало не применяется наполовину: сброс, пауза 30 мин, потом свежий полный список', async () => {
  const r = rig();
  r.put('items', 'd-1', { title: 'один' });
  await r.m.list('items');
  r.c.mode = 'badDelta';
  assert.equal(await r.m.list('items'), null);
  assert.match(r.logs[0], /дельта items: removed — не список строк/);
  r.c.mode = 'ok';
  r.tick(BACKOFF_MS);
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-1'], 'документа x из битой дельты нет');
  assert.equal(r.c.reqs.at(-1).includes('since='), false, 'после сброса — полный список');
});

test('документ без строкового id или объекта data — нарушение контракта в полном списке и в дельте: в зеркало не попадает, oq_list не падает на d.data (линза Claude #380, NB1)', async () => {
  for (const bad of [{ id: 'c-1' }, { data: {} }, { id: 7, data: {} }, { id: 'c-1', data: 'x' }, { id: 'c-1', data: [] }, 5, 'x', [], null]) {
    const r = rig();
    r.c.fullChecks = [bad];
    assert.equal(await r.m.list('checks'), null, JSON.stringify(bad));
    assert.match(r.logs[0], /полный список checks: документ без строкового id или объекта data/, JSON.stringify(bad));
  }
  for (const bad of [{ id: 'x' }, { id: 'x', data: null }, { data: { kind: 'decision' } }, null]) {
    const r = rig();
    r.put('items', 'd-1', { title: 'один' });
    await r.m.list('items');
    r.c.deltaItems = { docs: [bad], removed: [] };
    assert.equal(await r.m.list('items'), null, JSON.stringify(bad));
    assert.match(r.logs[0], /дельта items: документ без строкового id или объекта data/, JSON.stringify(bad));
    delete r.c.deltaItems;
    r.tick(BACKOFF_MS);
    const { docs } = await r.m.list('items');
    assert.deepEqual(docs.map((d) => d.id), ['d-1'], 'битого документа в зеркале нет');
    assert.equal(r.c.reqs.at(-1).includes('since='), false, 'после сброса — свежий полный список');
  }
});

test('коллекция дельты — не объект, без docs или removed, id в removed не строка — нарушение контракта, пауза 30 мин (линза Claude #380, NB2)', async () => {
  for (const bad of [5, 'x', true, [], { docs: [] }, { removed: [] }, { docs: {}, removed: [] }, { docs: [], removed: [7] }, { docs: [], removed: 'd-1' }]) {
    const r = rig();
    r.put('items', 'd-1', { title: 'один' });
    await r.m.list('items');
    r.c.deltaItems = bad;
    assert.equal(await r.m.list('items'), null, JSON.stringify(bad));
    assert.match(r.logs[0], /дельта \/changes не работает .*30 мин прежний полный список/, JSON.stringify(bad));
    r.tick(29 * 60_000);
    assert.equal(await r.m.list('items'), null, `${JSON.stringify(bad)}: пауза, а не повтор через минуту`);
  }
});

// OPS-27: полный список по страницам (сервер — OPS-22, консоль HR #837).
const isFirstPage = (p) => p.includes('paged=1') && !p.includes('page=');
const isNextPage = (p) => /[?&]page=/.test(p);

test('полный список по страницам (OPS-27): склейка коллекций, разрезанных страницами, пустая коллекция, один курсор — дальше дельта от него', async () => {
  const r = rig({ pageSize: 2 });
  r.put('checks', 'c-1', { done: true });
  for (let i = 1; i <= 5; i++) r.put('items', `d-${i}`, { title: `пункт ${i}` });
  assert.deepEqual((await r.m.list('items')).docs.map((d) => d.id), ['d-5', 'd-4', 'd-3', 'd-2', 'd-1']);
  assert.deepEqual((await r.m.list('checks')).docs.map((d) => d.id), ['c-1']);
  assert.deepEqual((await r.m.list('work')).docs, [], 'пустая коллекция пришла на последней странице');
  assert.equal(isFirstPage(r.c.reqs[0]), true, 'первая — paged=1');
  assert.deepEqual(r.c.reqs.slice(1, 3).map(isNextPage), [true, true], 'шесть документов по два — ещё две страницы по next');
  assert.deepEqual(r.c.reqs.slice(3).map((p) => p.includes('since=')), [true, true], 'дальше каждый вызов — дельта, не страницы');
  r.put('items', 'd-6', { title: 'шестой' });
  assert.equal((await r.m.list('items')).docs[0].id, 'd-6');
  assert.match(r.c.reqs.at(-1), /since=b1\.6$/, 'дельта — от курсора первой страницы');
  assert.ok(Math.max(...r.c.bytes.slice(0, 3)) < 1000, 'каждая страница — малое тело');
});

test('потолок коллекции (truncated) — со страницы, где коллекция кончилась; консоль без страниц (paged не знает) — одна страница', async () => {
  const r = rig({ pageSize: 1, truncatedWork: true });
  r.put('work', 'w-1', { title: 'строка' });
  r.put('work', 'w-2', { title: 'строка 2' });
  assert.deepEqual(await r.m.list('work').then(({ docs: _d, ...meta }) => meta), { truncated: true, total: 7, limit: 2 });
  const old = rig();
  old.put('items', 'd-1', { title: 'один' });
  assert.deepEqual((await old.m.list('items')).docs.map((d) => d.id), ['d-1']);
  assert.equal(old.c.reqs.length, 1);
  assert.equal(isFirstPage(old.c.reqs[0]), true, 'просим страницы, консоль отдала весь список без next');
});

test('консоль перезапущена между страницами (410 на странице 2) — один повтор с первой и строка в журнал; второй 410 — повтор через минуту, не пауза 30 мин', async () => {
  const f = fakeConsole({ pageSize: 2 });
  for (let i = 1; i <= 4; i++) f.put('items', `d-${i}`, { title: `пункт ${i}` });
  let restarts = 1;
  let t = 1_000_000;
  const logs = [];
  const get = async (p) => { if (isNextPage(p) && restarts > 0) { restarts -= 1; f.restart(); } return f.get(p); };
  const m = createDeltaMirror({ get, now: () => t, log: (s) => logs.push(s) });
  assert.deepEqual((await m.list('items')).docs.map((d) => d.id), ['d-4', 'd-3', 'd-2', 'd-1']);
  assert.deepEqual(f.c.reqs.map((p) => (isFirstPage(p) ? 'p1' : 'next')), ['p1', 'next', 'p1', 'next'], '410 → снова с первой');
  assert.deepEqual(logs, ['страница 2 полного списка устарела (консоль перезапущена) — повтор с первой'], 'повтор виден в журнале');

  const g = fakeConsole({ pageSize: 2 });
  for (let i = 1; i <= 4; i++) g.put('items', `d-${i}`, { title: `пункт ${i}` });
  let flaky = true;
  const logs2 = [];
  const m2 = createDeltaMirror({ get: async (p) => { if (flaky && isNextPage(p)) g.restart(); return g.get(p); }, now: () => t, log: (s) => logs2.push(s) });
  assert.equal(await m2.list('items'), null);
  assert.equal(g.c.reqs.length, 4, 'повтор — один, не по кругу');
  assert.match(logs2[1], /страница 2 снова устарела .*повтор дельты через 60 с/);
  t += RETRY_MS - 1;
  assert.equal(await m2.list('items'), null);
  assert.equal(g.c.reqs.length, 4, 'до повтора консоль не дёргаем');
  flaky = false;
  t += 1;
  assert.deepEqual((await m2.list('items')).docs.map((d) => d.id), ['d-4', 'd-3', 'd-2', 'd-1'], 'через минуту — полный список');
});

test('400 на странице 2 (токен отвергнут) — без повтора с первой: обычная ветка ошибки, пауза 30 мин', async () => {
  const f = fakeConsole({ pageSize: 2 });
  for (let i = 1; i <= 4; i++) f.put('items', `d-${i}`, { title: `пункт ${i}` });
  let t = 1_000_000;
  const logs = [];
  const m = createDeltaMirror({ get: async (p) => f.get(isNextPage(p) ? p.replace(/page=[^&]*/, 'page=bad!') : p), now: () => t, log: (s) => logs.push(s) });
  assert.equal(await m.list('items'), null);
  assert.deepEqual(f.c.reqs.map((p) => (isFirstPage(p) ? 'p1' : 'next')), ['p1', 'next'], 'второго прохода нет');
  assert.match(logs[0], /дельта \/changes не работает .*30 мин прежний полный список/);
  t += RETRY_MS;
  assert.equal(await m.list('items'), null);
  assert.equal(f.c.reqs.length, 2, 'пауза, а не повтор через минуту');
});

test('один id на двух страницах — в зеркале последняя версия', async () => {
  const f = fakeConsole({ pageSize: 1 });
  f.put('items', 'd-1', { title: 'один' });
  f.put('items', 'd-2', { title: 'два' });
  const again = { id: 'd-2', version: 2, data: { title: 'два, правка' }, updatedAt: 99, product: 'hr-helper' };
  const get = async (p) => {
    const j = await f.get(p);
    if (isNextPage(p) && j.collections.items) j.collections.items.docs.push(again);
    return j;
  };
  const m = createDeltaMirror({ get, now: () => 1_000_000, log: () => {} });
  const docs = (await m.list('items')).docs;
  assert.deepEqual(docs.map((d) => [d.id, d.data.title]), [['d-2', 'два, правка'], ['d-1', 'один']]);
});

test('страницы с разным курсором, next не строка, коллекция не пришла ни на одной странице — нарушение контракта, зеркало не собрано', async () => {
  const cases = [
    [(j, p) => (isNextPage(p) ? { ...j, cursor: 'b1.999' } : j), /страница 2 полного списка — с другим курсором/],
    [(j) => (j.next ? { ...j, next: 5 } : j), /next — не непустая строка/],
    [(j) => (j.next ? { ...j, next: '' } : j), /next — не непустая строка/],
    [(j) => { const { work: _w, ...collections } = j.collections; return { ...j, collections }; }, /в полном списке нет коллекции work/],
  ];
  for (const [mutate, re] of cases) {
    const f = fakeConsole({ pageSize: 1 });
    f.put('items', 'd-1', { title: 'один' });
    f.put('items', 'd-2', { title: 'два' });
    const logs = [];
    const m = createDeltaMirror({ get: async (p) => mutate(await f.get(p), p), now: () => 1_000_000, log: (s) => logs.push(s) });
    assert.equal(await m.list('items'), null, String(re));
    assert.match(logs[0], re);
    assert.match(logs[0], /30 мин прежний полный список/);
  }
});

test('консоль отдаёт next по кругу — первая страница без новых документов останавливает проход: нарушение контракта, пауза 30 мин', async () => {
  const reqs = [];
  const logs = [];
  let t = 1_000_000;
  const doc = { id: 'd-1', version: 1, data: { title: 'один' }, updatedAt: 1 };
  const get = async (p) => { reqs.push(p); return { full: true, cursor: 'b1.1', collections: { items: { docs: [doc] } }, next: 'eA' }; };
  const m = createDeltaMirror({ get, now: () => t, log: (s) => logs.push(s) });
  assert.equal(await m.list('items'), null);
  assert.equal(reqs.length, 2, 'вторая страница повторила первую — дальше не качаем');
  assert.match(logs[0], /страница 2 полного списка без новых документов, но с next.*30 мин прежний полный список/);
  t += RETRY_MS;
  assert.equal(await m.list('items'), null);
  assert.equal(reqs.length, 2, 'пауза, а не повтор через минуту');
});

test(`next с новыми документами дольше ${MAX_PAGES} страниц — нарушение контракта, пауза 30 мин, а не бесконечный цикл`, async () => {
  const reqs = [];
  const logs = [];
  let t = 1_000_000;
  const get = async (p) => { reqs.push(p); const n = reqs.length; return { full: true, cursor: 'b1.1', collections: { items: { docs: [{ id: `d-${n}`, version: 1, data: {}, updatedAt: 1e6 - n }] } }, next: `p${n}` }; };
  const m = createDeltaMirror({ get, now: () => t, log: (s) => logs.push(s) });
  assert.equal(await m.list('items'), null);
  assert.equal(reqs.length, MAX_PAGES);
  assert.match(logs[0], new RegExp(`полный список длиннее ${MAX_PAGES} страниц.*30 мин прежний полный список`));
  t += RETRY_MS;
  assert.equal(await m.list('items'), null);
  assert.equal(reqs.length, MAX_PAGES, 'пауза, а не повтор через минуту');
});

test('сбой посреди страниц (503 на странице 2) — как выкатка: повтор через минуту; прежнее зеркало и курсор целы до последней страницы', async () => {
  const f = fakeConsole({ pageSize: 2 });
  for (let i = 1; i <= 3; i++) f.put('items', `d-${i}`, { title: `пункт ${i}` });
  let t = 1_000_000;
  let down = false;
  const logs = [];
  const get = async (p) => { if (down && isNextPage(p)) throw Object.assign(new Error('Service Unavailable'), { status: 503 }); return f.get(p); };
  const m = createDeltaMirror({ get, now: () => t, log: (s) => logs.push(s) });
  await m.list('items');
  f.restart();
  f.put('items', 'd-4', { title: 'четвёртый' });
  down = true;
  assert.equal(await m.list('items'), null, 'дельта → 410 → страницы → 503');
  assert.match(logs[0], /Service Unavailable.*повтор дельты через 60 с/);
  down = false;
  t += RETRY_MS;
  assert.deepEqual((await m.list('items')).docs.map((d) => d.id), ['d-4', 'd-3', 'd-2', 'd-1']);
  assert.match(f.c.reqs.find((p) => p.includes('since=')), /since=b1\.3$/, 'после сбоя — дельта от старого курсора (зеркало не тронуто)');
});
