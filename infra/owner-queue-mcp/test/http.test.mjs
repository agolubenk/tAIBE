// OPS-79 (HR OPS-22): медленный полный /changes. Таймаут списка — свой, оборванное тело — ошибка без status, а не `{}`;
// у прежнего опроса автопередачи ETag — только вместе с разобранным телом, без цикла 304.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LIST_TIMEOUT_MS, TIMEOUT_MS, isListRead, request, timeoutsFromEnv } from '../http.mjs';
import { createDeltaMirror } from '../delta.mjs';
import { createPoller } from '../relay.mjs';

const TIMEOUTS = { call: 200, list: 2_000 };
const FULL = JSON.stringify({ full: true, cursor: 'b1.5', collections: { checks: { docs: [] }, items: { docs: [{ id: 'i-1', version: 1, updatedAt: 1, data: { kind: 'inbox', title: 'один' } }] }, work: { docs: [] } } });

/** Заголовки сразу, тело — частями: первые байты сейчас, остальное через ms (как 1,64 МБ за 43 с). */
function stall(res, ms, body, headers = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.write(body.slice(0, 5));
  setTimeout(() => { if (!res.destroyed) res.end(body.slice(5)); }, ms);
}

async function serve(t, handler) {
  const reqs = [];
  const srv = createServer((req, res) => { reqs.push({ url: req.url, inm: req.headers['if-none-match'] }); handler(req, res, reqs.length); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { base: `http://127.0.0.1:${srv.address().port}`, reqs };
}

test('isListRead: полный /changes и GET /db/<коллекция> — список; дельта от курсора, пункт и запись — обычный запрос', () => {
  assert.equal(isListRead('GET', '/changes?col=checks,items,work'), true);
  assert.equal(isListRead('GET', '/changes'), true);
  assert.equal(isListRead('GET', '/changes?col=checks,items&since=b1.5'), false);
  assert.equal(isListRead('GET', '/db/items'), true);
  assert.equal(isListRead('GET', '/db/items?open=1&product=taibe'), true);
  assert.equal(isListRead('GET', '/db/items/i-1'), false);
  assert.equal(isListRead('PUT', '/db/items'), false);
  assert.equal(isListRead('GET', '/files?item=i-1'), false);
});

test('timeoutsFromEnv: по умолчанию 20 с и 120 с; неверное значение — по умолчанию', () => {
  assert.deepEqual(timeoutsFromEnv({}), { call: TIMEOUT_MS, list: LIST_TIMEOUT_MS });
  assert.deepEqual(timeoutsFromEnv({ OQ_TIMEOUT_MS: '500', OQ_LIST_TIMEOUT_MS: '9000' }), { call: 500, list: 9_000 });
  assert.deepEqual(timeoutsFromEnv({ OQ_TIMEOUT_MS: '-1', OQ_LIST_TIMEOUT_MS: 'abc' }), { call: TIMEOUT_MS, list: LIST_TIMEOUT_MS });
});

test('полный /changes дольше обычного таймаута, но в пределах таймаута списка — дочитан; зеркало без ошибки контракта', async (t) => {
  const s = await serve(t, (req, res) => stall(res, 600, FULL));
  const logs = [];
  const m = createDeltaMirror({ get: (p) => request({ base: s.base, token: 't', method: 'GET', path: p, timeouts: TIMEOUTS }), log: (x) => logs.push(x) });
  const items = await m.list('items');
  assert.deepEqual(items.docs.map((d) => d.id), ['i-1']);
  assert.deepEqual(logs, [], 'нет строки «не по контракту» и нет отката на прежний путь');
});

test('тело не дочитано за таймаут — ошибка без status, а не `{}`: дельта считает это временным сбоем, зеркало не сброшено на 30 мин', async (t) => {
  const s = await serve(t, (req, res) => stall(res, 1_500, FULL));
  const short = { call: 200, list: 300 };
  const err = await request({ base: s.base, token: 't', method: 'GET', path: '/changes?col=items', timeouts: short }).then(() => null, (e) => e);
  assert.ok(err, 'оборванное тело не стало ответом');
  assert.equal(err.status, undefined);
  assert.match(err.message, /не дочитан/);
  const logs = [];
  const m = createDeltaMirror({ get: (p) => request({ base: s.base, token: 't', method: 'GET', path: p, timeouts: short }), log: (x) => logs.push(x) });
  assert.equal(await m.list('items'), null, 'прежний путь на этот вызов');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /не ответила на \/changes/, 'временный сбой: повтор через минуту');
  assert.doesNotMatch(logs[0], /не по контракту|30 мин/);
});

test('дельта от курсора — обычный таймаут: медленный ответ на since обрывается за call, а не ждёт таймаут списка', async (t) => {
  const s = await serve(t, (req, res) => stall(res, 1_000, JSON.stringify({ cursor: 'b1.6', changes: {} })));
  const t0 = Date.now();
  const err = await request({ base: s.base, token: 't', method: 'GET', path: '/changes?col=items&since=b1.5', timeouts: TIMEOUTS }).then(() => null, (e) => e);
  assert.ok(err);
  assert.ok(Date.now() - t0 < 900, `оборван за ${Date.now() - t0} мс`);
});

test('ошибка HTTP — status и текст консоли, как раньше', async (t) => {
  const s = await serve(t, (req, res) => { res.writeHead(410, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'курсор устарел' })); });
  const err = await request({ base: s.base, token: 't', method: 'GET', path: '/changes?since=b0.1', timeouts: TIMEOUTS }).then(() => null, (e) => e);
  assert.equal(err.status, 410);
  assert.equal(err.message, 'курсор устарел');
});

test('автопередача без дельты: тело оборвалось — ETag не запомнен; следующий проход без If-None-Match получает данные, цикла 304 нет', async (t) => {
  const docs = JSON.stringify({ docs: [{ id: 'i-1', version: 1, data: { kind: 'inbox' } }] });
  const s = await serve(t, (req, res, n) => {
    if (n === 1) return stall(res, 1_500, docs, { etag: 'W/"items-1"' });
    if (req.headers['if-none-match'] === 'W/"items-1"') { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"items-1"' });
    res.end(docs);
  });
  const poll = createPoller({ base: s.base, token: 't', timeoutMs: 300 });
  await assert.rejects(poll('items'), /не дочитан/);
  assert.deepEqual((await poll('items')).map((d) => d.id), ['i-1'], 'второй проход — данные, а не «HTTP 304»');
  assert.deepEqual((await poll('items')).map((d) => d.id), ['i-1'], 'третий — 304 и те же данные');
  assert.deepEqual(s.reqs.map((r) => r.inm ?? null), [null, null, 'W/"items-1"']);
});

test('автопередача без дельты: 200 без docs — ошибка, ETag не запомнен (иначе тот же цикл 304)', async (t) => {
  const s = await serve(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"x"' }); res.end('{}'); });
  const poll = createPoller({ base: s.base, token: 't', timeoutMs: 1_000 });
  await assert.rejects(poll('items'), /ответ без docs/);
  await assert.rejects(poll('items'), /ответ без docs/);
  assert.deepEqual(s.reqs.map((r) => r.inm ?? null), [null, null]);
});
