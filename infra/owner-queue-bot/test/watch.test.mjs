// Сигнал «страница без базы» (watch.mjs): выкатка консоли — без сообщений, долгий сбой — 🟠 и 🟢, токен — сразу.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher, LOCAL_GRACE_MS } from '../watch.mjs';

/**
 * Страница как в боте: перезагрузка даёт новую вкладку — window.__oqConn пуст (conn null), а при лежащей консоли
 * вкладка не открывается вовсе (snap бросает, как findFrame → NotReadyError). up — консоль отвечает.
 */
function harness() {
  let t = 1_000_000;
  let mode = 'local';
  let up = true;
  let standby = false;
  let conn = { okAt: t - 5_000, errAt: t, err: 'HTTP 502', status: 502, fails: 3 };
  const sent = [];
  const reloads = [];
  const mirror = {
    openedAt: t, generation: 0,
    reload: async () => { reloads.push(t); mirror.openedAt = t; conn = null; },
  };
  const snapOf = () => {
    if (!up && conn === null) throw new Error('Страница артефакта не открылась');
    return { title: 'Очередь', progress: 'Сделано 0 из 0', checkedAt: '', mode, news: [''], items: [], sections: [], conn };
  };
  const w = createWatcher({
    store: { state: { chats: {}, known: {} }, config: { notify: true }, isOwner: () => true, saveState() {} },
    tg: { edit: async () => {} },
    mirror,
    snap: async () => snapOf(),
    broadcast: async (m) => { sent.push(m.text); },
    errText: (e) => `⏳ ${e.message}`, hint: 'token-list', log() {}, isStandby: () => standby,
    now: () => t,
  });
  return {
    sent, reloads, tick: () => w.tick(), now: () => t,
    advance(ms) { t += ms; }, set(m, c) { mode = m; if (c !== undefined) conn = c; }, down() { up = false; }, upAgain() { up = true; },
    standby(v) { standby = v; },
  };
}
const minute = async (h, n) => { for (let i = 0; i < n; i++) { h.advance(60_000); await h.tick(); } };

test('выкатка: страница без базы меньше 3 мин и вернулась сама — владельцу ничего, страницу не перезагружали', async () => {
  const h = harness();
  await h.tick();
  await minute(h, 2);
  h.set('shared'); h.advance(4_000); await h.tick();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.reloads, [], 'перезагрузка до сигнала оборвала бы восстановление на месте (линза Claude #319, B1)');
});

test('связи нет 3 мин — один 🟠 с причиной и временем удачного ответа, перезагрузка — через минуту после него; вернулась — 🟢', async () => {
  const h = harness();
  await h.tick();
  for (let i = 0; i < 4; i++) { h.advance(LOCAL_GRACE_MS / 4); await h.tick(); }
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /^🟠 <b>Очередь не подключилась к консоли<\/b>/);
  assert.match(h.sent[0], /ошибкой 502/);
  assert.match(h.sent[0], /Последний удачный ответ консоли — \d\d:\d\d МСК/);
  assert.match(h.sent[0], /перезагрузит страницу через 1 мин/);
  assert.deepEqual(h.reloads, [], 'сигнал раньше перезагрузки');
  await minute(h, 1);
  assert.equal(h.reloads.length, 1, 'через минуту после сигнала — перезагрузка');
  h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 }); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^🟢 .*Связи не было около 4 мин/);
  // Следующий сбой — снова с отсрочкой.
  h.set('local'); await h.tick();
  assert.equal(h.sent.length, 2);
});

test('страница перезагрузилась посреди сбоя (не открылась, __oqConn пуст) — 🟠 всё равно несёт время последнего удачного ответа', async () => {
  const h = harness();
  h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 });
  await h.tick();
  const okAt = new Date(h.now());
  h.set('local', { okAt: h.now(), errAt: h.now() + 1, err: 'HTTP 503', status: 503, fails: 1 });
  h.advance(30_000); await h.tick();
  // Вкладка не отвечает три тика подряд — бот перезагружает её (watch.mjs, failStreak % 6 === 3): новая страница пуста.
  h.down(); h.set('local', null);
  for (let i = 0; i < 3; i++) { h.advance(20_000); await h.tick(); }
  h.upAgain(); h.set('local', { okAt: 0, errAt: h.now(), err: 'HTTP 503', status: 503, fails: 2 });
  h.advance(LOCAL_GRACE_MS); await h.tick();
  assert.equal(h.sent.length, 1);
  const hm = okAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  assert.match(h.sent[0], new RegExp(`Последний удачный ответ консоли — ${hm} МСК`));
  assert.doesNotMatch(h.sent[0], /Удачных ответов консоли с открытия страницы не было/);
});

test('консоль лежит целиком: 🟠 с причиной до перезагрузки; вкладка потом не открылась — второго «⏳» нет; вернулась — 🟢', async () => {
  const h = harness();
  await h.tick();
  h.down();
  await minute(h, 3);
  assert.equal(h.sent.length, 1, 'сигнал с причиной пришёл, пока вкладка ещё жива');
  assert.match(h.sent[0], /ошибкой 502/);
  await minute(h, 6); // перезагрузка на 4-й минуте — вкладка не открывается, снимки падают
  assert.equal(h.reloads.length >= 1, true);
  assert.equal(h.sent.length, 1, 'без общего «⏳ Страница артефакта не открылась»');
  h.upAgain(); h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 }); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^🟢 /);
});

test('консоль не приняла токен (401) — 🟠 сразу: сам он не вернётся', async () => {
  const h = harness();
  h.set('local', { okAt: 0, errAt: 1, err: 'HTTP 401', status: 401, fails: 3 });
  await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /не приняла токен бота \(ответ 401\)/);
});

test('почасовая свежая вкладка не перезагружает страницу посреди сбоя', async () => {
  const h = harness();
  h.advance(3600_000 - 60_000);
  await h.tick(); // без базы с этой минуты
  await minute(h, 2); // час с открытия прошёл, но страница без базы — плановой перезагрузки нет
  assert.deepEqual(h.reloads, []);
});

test('страница с базой до первого удачного опроса (okAt 0) — 🟠 говорит «удачных ответов не было», а не время старта бота (линза Claude #319, п. 1)', async () => {
  const h = harness();
  h.set('shared', { okAt: 0, errAt: h.now(), err: 'HTTP 503', status: 503, fails: 1 });
  await h.tick();
  h.set('local', { okAt: 0, errAt: h.now(), err: 'HTTP 503', status: 503, fails: 2 });
  await h.tick();
  h.advance(LOCAL_GRACE_MS); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Удачных ответов консоли с открытия страницы не было/);
});

test('ранний shared новой вкладки при лежащем API — не возврат связи; 🟢 — только после удачного опроса (линза Claude #319, п. 2)', async () => {
  const h = harness();
  await h.tick();
  await minute(h, 3);
  assert.equal(h.sent.length, 1, '🟠');
  await minute(h, 1);
  assert.equal(h.reloads.length, 1);
  // Новая вкладка: база есть (shared), но опрос API ещё не удался — okAt старый.
  h.set('shared', { okAt: h.now() - 600_000, errAt: h.now(), err: 'HTTP 503', status: 503, fails: 1 }); await h.tick();
  assert.equal(h.sent.length, 1, 'без 🟢: удачного опроса после начала сбоя не было');
  h.set('local'); h.advance(20_000); await h.tick();
  assert.equal(h.sent.length, 1, 'и без второго 🟠: сбой тот же');
  h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 }); await h.tick();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /^🟢 /);
});

test('резервный бот помнит время удачного ответа: стал активным посреди сбоя — 🟠 с этим временем (линза Claude #319, п. 3)', async () => {
  const h = harness();
  h.standby(true);
  h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 });
  await h.tick();
  const hm = new Date(h.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  h.standby(false);
  h.down(); h.set('local', null);
  for (let i = 0; i < 3; i++) { h.advance(20_000); await h.tick(); } // вкладка не отвечает — перезагрузка, __oqConn пуст
  h.upAgain(); h.set('local', { okAt: 0, errAt: h.now(), err: 'HTTP 503', status: 503, fails: 2 });
  await h.tick();
  h.advance(LOCAL_GRACE_MS); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], new RegExp(`Последний удачный ответ консоли — ${hm} МСК`));
});

test('снимок связи: старая консоль — conn null; запись есть, а опроса checks ещё не было — okAt 0, не null (линза Claude #370, N1)', async () => {
  const { snapshotPage } = await import('../frame-scripts.mjs');
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  try {
    globalThis.window = {};
    assert.equal(snapshotPage().conn, null, 'старая консоль без __oqConn');
    globalThis.window = { __oqConn: {} };
    assert.deepEqual(snapshotPage().conn, { okAt: 0, errAt: 0, err: '', status: 0, fails: 0 }, 'новая вкладка до первого опроса');
    globalThis.window = { __oqConn: { checks: { okAt: 5, errAt: 0, err: '', status: 0, fails: 0 } } };
    assert.equal(snapshotPage().conn.okAt, 5);
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  }
});

test('новая вкладка дала базу до первого опроса (okAt 0) посреди сбоя — не 🟢 (линза Claude #370, N1)', async () => {
  const h = harness();
  await h.tick();
  await minute(h, 3);
  assert.equal(h.sent.length, 1, '🟠');
  await minute(h, 1); // перезагрузка
  h.set('shared', { okAt: 0, errAt: 0, err: '', status: 0, fails: 0 }); await h.tick();
  assert.equal(h.sent.length, 1, 'база есть, опроса не было — связь не вернулась');
  h.set('shared', { okAt: h.now(), errAt: 0, err: '', status: 0, fails: 0 }); await h.tick();
  assert.match(h.sent[1], /^🟢 /);
});
