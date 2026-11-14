// Сигнал «страница без базы» (watch.mjs): выкатка консоли — без сообщений, долгий сбой — 🟠 и 🟢, токен — сразу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher, LOCAL_GRACE_MS } from '../watch.mjs';

function harness() {
  let t = 1_000_000;
  let mode = 'local';
  let conn = { okAt: t - 5_000, errAt: t, err: 'HTTP 502', status: 502, fails: 3 };
  const sent = [];
  const reloads = [];
  const snapOf = () => ({
    title: 'Очередь', progress: 'Сделано 0 из 0', checkedAt: '', mode, news: [''], items: [], sections: [], conn,
  });
  const w = createWatcher({
    store: { state: { chats: {}, known: {} }, config: { notify: true }, isOwner: () => true, saveState() {} },
    tg: { edit: async () => {} },
    mirror: { openedAt: t, generation: 0, reload: async () => { reloads.push(t); } },
    snap: async () => snapOf(),
    broadcast: async (m) => { sent.push(m.text); },
    errText: (e) => String(e), hint: 'token-list', log() {}, isStandby: () => false,
    now: () => t,
  });
  return {
    sent, reloads, tick: () => w.tick(),
    advance(ms) { t += ms; }, set(m, c) { mode = m; if (c) conn = c; },
  };
}

test('выкатка: страница без базы меньше 3 мин и вернулась сама — владельцу ничего', async () => {
  const h = harness();
  await h.tick();
  h.advance(60_000); await h.tick();
  h.advance(60_000); await h.tick();
  h.set('shared'); h.advance(4_000); await h.tick();
  assert.deepEqual(h.sent, []);
  assert.equal(h.reloads.length, 1, 'через минуту страница перезагружается и без сигнала');
});

test('связи нет 3 мин — один 🟠 с причиной; вернулась — 🟢 со временем простоя', async () => {
  const h = harness();
  await h.tick();
  for (let i = 0; i < 4; i++) { h.advance(LOCAL_GRACE_MS / 4); await h.tick(); }
  h.advance(30_000); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^🟠 <b>Очередь не подключилась к консоли<\/b>/);
  assert.match(h.sent[0], /ошибкой 502/);
  h.set('shared'); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^🟢 .*Связи не было около 4 мин/);
  // Следующий сбой — снова с отсрочкой.
  h.set('local'); await h.tick();
  assert.equal(h.sent.length, 2);
});

test('консоль не приняла токен (401) — 🟠 сразу: сам он не вернётся', async () => {
  const h = harness();
  h.set('local', { okAt: 0, errAt: 1, err: 'HTTP 401', status: 401, fails: 3 });
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /не приняла токен бота \(ответ 401\)/);
});
