// OPS-76: ответ владельца подтверждается ответом консоли на запись checks/<id>, без ожидания опроса страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CHANGED_ELSEWHERE, SAVE_FAILED, pathOf, watchSave } from '../save-confirm.mjs';

const BASE = 'https://ops.example/api/oq/v1/db/';
const resp = ({ method = 'PATCH', url = BASE + 'checks/d-1', status = 200, data = { choice: 'a' } } = {}) => ({
  request: () => ({ method: () => method }),
  url: () => url,
  status: () => status,
  ok: () => status >= 200 && status < 300,
  json: async () => ({ id: 'd-1', data, version: 3 }),
});
const pageOf = () => Object.assign(new EventEmitter(), { off(e, f) { this.removeListener(e, f); } });

test('сохранённая запись совпала с ожидаемой — подтверждено сразу, не через 6 с', async () => {
  const page = pageOf();
  const w = watchSave(page, 'd-1');
  const t = Date.now();
  setTimeout(() => page.emit('response', resp()), 20);
  assert.deepEqual(await w.result((d) => d.choice === 'a', 5_000), { ok: true, confirmed: true });
  assert.ok(Date.now() - t < 1_000);
  w.stop();
  assert.equal(page.listenerCount('response'), 0, 'stop снимает подписку');
});

test('ответ пришёл до result (быстрая консоль) — не теряется', async () => {
  const page = pageOf();
  const w = watchSave(page, 'd-1');
  page.emit('response', resp());
  assert.equal((await w.result((d) => d.choice === 'a', 50)).confirmed, true);
});

test('чужой пункт, опрос GET и другая коллекция не подтверждают', async () => {
  const page = pageOf();
  const w = watchSave(page, 'd-1');
  page.emit('response', resp({ url: BASE + 'checks/d-10' }));
  page.emit('response', resp({ method: 'GET', url: BASE + 'checks' }));
  page.emit('response', resp({ url: BASE + 'items/d-1' }));
  assert.deepEqual(await w.result(() => true, 100), { ok: true, confirmed: false });
});

test('прежняя правка того же пункта не засчитывается, следующая совпавшая — да', async () => {
  const page = pageOf();
  const w = watchSave(page, 'd-1');
  page.emit('response', resp({ data: { choice: 'b' } }));
  setTimeout(() => page.emit('response', resp({ method: 'PUT', data: { choice: 'a' } })), 20);
  assert.equal((await w.result((d) => d.choice === 'a', 2_000)).confirmed, true);
});

test('409 — ответ изменён в другом месте; другой отказ консоли — не сохранено', async () => {
  let page = pageOf();
  let w = watchSave(page, 'd-1');
  page.emit('response', resp({ status: 409 }));
  assert.deepEqual(await w.result(() => true, 100), { ok: false, error: CHANGED_ELSEWHERE });
  page = pageOf();
  w = watchSave(page, 'd-1');
  page.emit('response', resp({ status: 503 }));
  assert.deepEqual(await w.result(() => true, 100), { ok: false, error: SAVE_FAILED });
});

test('id с символами, которые страница кодирует (encodeURIComponent), сравнивается раскодированным', async () => {
  assert.equal(pathOf(BASE + 'checks/taibe-m-405%2F1'), '/api/oq/v1/db/checks/taibe-m-405/1');
  assert.equal(pathOf('не адрес'), '');
  const page = pageOf();
  const w = watchSave(page, 'i-20261115-120000-ab cd');
  page.emit('response', resp({ url: BASE + 'checks/' + encodeURIComponent('i-20261115-120000-ab cd') }));
  assert.equal((await w.result(() => true, 100)).confirmed, true);
});
