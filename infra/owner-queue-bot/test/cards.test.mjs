// Карточка пункта из нескольких сообщений: 🔄 и итог действия обновляют все её сообщения (карточка HR nc8uj786).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS_PER_CHAT, STALE_TEXT, createCards } from '../cards.mjs';

function harness({ failEdit = () => false } = {}) {
  const screen = new Map(); // id → { text, keyboard }
  let next = 100;
  let t = 0;
  const store = { state: {}, saves: 0, saveState() { this.saves++; } };
  const send = async (chatId, msg) => { const id = ++next; screen.set(id, { text: msg.text, keyboard: msg.keyboard || null }); return { message_id: id }; };
  const edit = async (chatId, id, msg) => {
    if (!screen.has(id) || failEdit(id)) return false;
    screen.set(id, { text: msg.text, keyboard: msg.keyboard || null });
    return true;
  };
  const cards = createCards({ store, send, edit, now: () => ++t });
  return { cards, screen, store, texts: () => [...screen.values()].map((m) => m.text) };
}

const card = (cmd, extra = []) => [{ text: 'Тело пункта' }, { text: `<pre>${cmd}</pre>` }, ...extra, { text: 'Ответ', keyboard: [[{ text: '🔄' }]] }];

test('🔄 на карточке из трёх сообщений: новая команда — во всех, на тех же местах', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, card('echo old'));
  assert.equal(ids.length, 3);
  const r = await h.cards.refreshCard(1, ids[2], card('echo new'));
  assert.deepEqual(r, { inPlace: true });
  assert.equal(h.screen.get(ids[1]).text, '<pre>echo new</pre>');
  assert.ok(!h.texts().some((s) => s.includes('echo old')), 'старой команды на экране нет');
  assert.equal(h.screen.size, 3, 'новых сообщений не прислано');
  // Повторный 🔄 по тому же последнему сообщению — снова на месте.
  assert.deepEqual(await h.cards.refreshCard(1, ids[2], card('echo newer')), { inPlace: true });
  assert.equal(h.screen.get(ids[1]).text, '<pre>echo newer</pre>');
});

test('сообщений стало больше: старые — пометка без кнопок, свежая карточка ниже, её 🔄 тоже работает', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, card('echo old'));
  const r = await h.cards.refreshCard(1, ids[2], card('echo new', [{ text: '<pre>echo second</pre>' }]));
  assert.deepEqual(r, { inPlace: false });
  for (const id of ids) assert.deepEqual(h.screen.get(id), { text: STALE_TEXT, keyboard: null });
  assert.equal(h.screen.size, 7);
  assert.ok(!h.texts().some((s) => s.includes('echo old')));
  const lastNew = Math.max(...h.screen.keys());
  assert.deepEqual(await h.cards.refreshCard(1, lastNew, card('echo 3', [{ text: '<pre>echo second</pre>' }])), { inPlace: true });
});

test('правка не удалась (сообщение удалено владельцем) — пометка на остальных и свежая карточка', async () => {
  const h = harness({ failEdit: (id) => id === 101 });
  const ids = await h.cards.sendCard(1, card('echo old'));
  const r = await h.cards.refreshCard(1, ids[2], card('echo new'));
  assert.deepEqual(r, { inPlace: false });
  assert.equal(h.screen.get(ids[1]).text, STALE_TEXT);
  assert.equal(h.screen.get(ids[2]).text, STALE_TEXT);
  assert.ok(h.texts().filter((s) => s === '<pre>echo new</pre>').length === 1);
});

test('карточка, которую бот не помнит (старше памяти или отправлена до обновления), — правится её последнее сообщение', async () => {
  const h = harness();
  const { message_id: id } = await (async () => ({ message_id: (await h.cards.sendCard(1, [{ text: 'Ответ' }]))[0] }))();
  delete h.store.state.cards[1][id];
  assert.deepEqual(await h.cards.refreshCard(1, id, [{ text: 'Ответ 2' }]), { inPlace: true });
  assert.equal(h.screen.get(id).text, 'Ответ 2');
});

test('память ограничена: на чат не больше CARDS_PER_CHAT карточек, забываются самые старые', async () => {
  const h = harness();
  const first = (await h.cards.sendCard(7, [{ text: 'a' }]))[0];
  for (let i = 0; i < CARDS_PER_CHAT + 5; i++) await h.cards.sendCard(7, [{ text: `x${i}` }]);
  const kept = Object.keys(h.store.state.cards[7]);
  assert.equal(kept.length, CARDS_PER_CHAT);
  assert.ok(!kept.includes(String(first)));
});
