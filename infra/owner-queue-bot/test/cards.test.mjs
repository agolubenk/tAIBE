// Карточка пункта из нескольких сообщений: 🔄 и итог действия обновляют все её сообщения (карточка HR nc8uj786).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS_PER_CHAT, STALE_TEXT, createCards, kindOf, telegramCardOps } from '../cards.mjs';
import { retryFlood } from '../telegram.mjs';

/**
 * Экран Telegram: текст правится текстом, файл — файлом (editMessageMedia), подпись файла — editMessageCaption.
 * Текстом файл не правится и наоборот — как в Bot API. failEdit/failSend — сбой (удалено, 429, сеть).
 */
function harness({ failEdit = () => false, failSend = () => false } = {}) {
  const screen = new Map(); // id → { kind, text | file, caption, keyboard }
  let next = 100;
  let t = 0;
  let sends = 0;
  const store = { state: {}, saves: 0, saveState() { this.saves++; } };
  const show = (msg) => (msg.document
    ? { kind: 'doc', file: msg.document.text, caption: msg.document.caption || '', keyboard: null }
    : { kind: 'text', text: msg.text, keyboard: msg.keyboard || null });
  const send = async (chatId, msg) => {
    if (failSend(++sends)) throw Object.assign(new Error('sendMessage: Too Many Requests'), { code: 429, retryAfter: 30 });
    const id = ++next;
    screen.set(id, show(msg));
    return { message_id: id };
  };
  const edit = async (chatId, id, msg) => {
    const m = screen.get(id);
    if (!m || failEdit(id) || m.kind !== kindOf(msg)) return false;
    screen.set(id, show(msg));
    return true;
  };
  const stale = async (chatId, id, kind) => {
    const m = screen.get(id);
    if (!m || m.kind !== kind) return false;
    screen.set(id, kind === 'doc' ? { ...m, caption: STALE_TEXT } : { kind: 'text', text: STALE_TEXT, keyboard: null });
    return true;
  };
  const cards = createCards({ store, send, edit, stale, now: () => ++t });
  const shown = () => [...screen.values()].map((m) => m.text ?? m.file);
  return { cards, screen, store, shown };
}

const card = (cmd, extra = []) => [{ text: 'Тело пункта' }, { text: `<pre>${cmd}</pre>` }, ...extra, { text: 'Ответ', keyboard: [[{ text: '🔄' }]] }];
const doc = (cmd) => ({ document: { name: 'd-x-1.sh', text: cmd, caption: 'Команда целиком' } });
const fileCard = (cmd) => [{ text: 'Тело пункта' }, doc(cmd), { text: 'Ответ', keyboard: [[{ text: '🔄' }]] }];

test('🔄 на карточке из трёх сообщений: новая команда — во всех, на тех же местах', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, card('echo old'));
  assert.equal(ids.length, 3);
  const r = await h.cards.refreshCard(1, ids[2], card('echo new'));
  assert.deepEqual(r, { inPlace: true });
  assert.equal(h.screen.get(ids[1]).text, '<pre>echo new</pre>');
  assert.ok(!h.shown().some((s) => s.includes('echo old')), 'старой команды на экране нет');
  assert.equal(h.screen.size, 3, 'новых сообщений не прислано');
  // Повторный 🔄 по тому же последнему сообщению — снова на месте.
  assert.deepEqual(await h.cards.refreshCard(1, ids[2], card('echo newer')), { inPlace: true });
  assert.equal(h.screen.get(ids[1]).text, '<pre>echo newer</pre>');
});

test('сообщений стало больше: свежая карточка ниже, старые — пометка без кнопок, её 🔄 тоже работает', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, card('echo old'));
  const r = await h.cards.refreshCard(1, ids[2], card('echo new', [{ text: '<pre>echo second</pre>' }]));
  assert.deepEqual(r, { inPlace: false });
  for (const id of ids) assert.deepEqual(h.screen.get(id), { kind: 'text', text: STALE_TEXT, keyboard: null });
  assert.equal(h.screen.size, 7);
  assert.ok(!h.shown().some((s) => s.includes('echo old')));
  assert.equal(h.store.state.cards[1][ids[2]], undefined, 'старая запись забыта');
  const lastNew = Math.max(...h.screen.keys());
  assert.deepEqual(await h.cards.refreshCard(1, lastNew, card('echo 3', [{ text: '<pre>echo second</pre>' }])), { inPlace: true });
});

test('правка не удалась (сообщение удалено владельцем) — свежая карточка и пометка на остальных', async () => {
  const h = harness({ failEdit: (id) => id === 101 });
  const ids = await h.cards.sendCard(1, card('echo old'));
  const r = await h.cards.refreshCard(1, ids[2], card('echo new'));
  assert.deepEqual(r, { inPlace: false });
  assert.equal(h.screen.get(ids[1]).text, STALE_TEXT);
  assert.equal(h.screen.get(ids[2]).text, STALE_TEXT);
  assert.equal(h.shown().filter((s) => s === '<pre>echo new</pre>').length, 1);
});

test('карточка с файлом длинной команды: 🔄 меняет файл на месте, новых сообщений нет (линза Claude #343, B1)', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, fileCard('echo old-long'));
  for (const cmd of ['echo new-long', 'echo newer-long', 'echo newest-long']) {
    assert.deepEqual(await h.cards.refreshCard(1, ids[2], fileCard(cmd)), { inPlace: true });
  }
  assert.equal(h.screen.size, 3, 'три нажатия — по-прежнему три сообщения');
  assert.equal(h.screen.get(ids[1]).file, 'echo newest-long');
  assert.ok(!h.shown().some((s) => s.includes('old-long')), 'старого файла на экране нет');
});

test('файл сменился текстом (команда стала короче): свежая карточка ниже, старый файл помечен подписью', async () => {
  const h = harness();
  const ids = await h.cards.sendCard(1, fileCard('echo old-long'));
  assert.deepEqual(await h.cards.refreshCard(1, ids[2], card('echo short')), { inPlace: false });
  assert.equal(h.screen.get(ids[1]).caption, STALE_TEXT, 'у файла — пометка подписью');
  assert.equal(h.screen.get(ids[0]).text, STALE_TEXT);
  assert.equal(h.screen.get(ids[2]).keyboard, null, 'у старой карточки кнопок нет');
  assert.equal(h.screen.size, 6);
});

test('свежая карточка не ушла (429, сеть): старая не тронута и с кнопками, запись цела, следующий 🔄 обновляет всё (B2)', async () => {
  let down = false;
  const h = harness({ failEdit: () => down, failSend: () => down });
  const first = await h.cards.sendCard(1, card('echo old'));
  down = true;
  await assert.rejects(h.cards.refreshCard(1, first[2], card('echo new')), /Too Many Requests/);
  assert.equal(h.screen.get(first[1]).text, '<pre>echo old</pre>', 'старая команда без пометки — но и без обрыва: свежей нет');
  assert.deepEqual(h.screen.get(first[2]).keyboard, [[{ text: '🔄' }]], 'кнопки на месте — владелец может нажать 🔄 снова');
  assert.deepEqual(h.store.state.cards[1][first[2]].ids, first, 'бот помнит все сообщения карточки');
  down = false;
  assert.deepEqual(await h.cards.refreshCard(1, first[2], card('echo new')), { inPlace: true });
  assert.ok(!h.shown().some((s) => s.includes('echo old')), 'после сбоя старой команды не осталось нигде');
});

test('карточка, которую бот не помнит (старше памяти или отправлена до обновления), — правится её последнее сообщение', async () => {
  const h = harness();
  const [id] = await h.cards.sendCard(1, [{ text: 'Ответ' }]);
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

test('связка с Telegram (telegramCardOps): файл — editMessageMedia, пометка файла — подписью, разметка — запасной путь, 429 — повтор', async () => {
  const calls = [];
  let flood = 1;
  const tg = {
    edit: async (chatId, id, text, extra = {}) => { // как TelegramApi.edit: extra по умолчанию {}
      calls.push(['edit', id, text, !!extra.reply_markup]);
      if (text.includes('<bad>')) throw new Error("editMessageText: can't parse entities");
      if (text.includes('flood') && flood-- > 0) throw Object.assign(new Error('Too Many Requests'), { code: 429, retryAfter: 1 });
      if (text.includes('gone')) throw new Error('editMessageText: message to edit not found');
    },
    editDocument: async (chatId, id, name, text) => { calls.push(['editDocument', id, name, text]); },
    call: async (method, p) => { calls.push([method, p.message_id, p.text ?? p.caption]); },
  };
  const logs = [];
  const ops = telegramCardOps({ tg, markup: (k) => (k ? { reply_markup: { inline_keyboard: k } } : {}), toPlain: (s) => s.replace(/<[^>]+>/g, ''), sleep: async () => {}, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(await ops.edit(1, 10, doc('echo long')), true);
  assert.deepEqual(calls.pop(), ['editDocument', 10, 'd-x-1.sh', 'echo long']);
  assert.equal(await ops.edit(1, 11, { text: 'a <bad>b', keyboard: [[{ text: '🔄' }]] }), true);
  assert.deepEqual(calls.pop(), ['editMessageText', 11, 'a b'], 'без разметки — простым текстом');
  assert.equal(await ops.edit(1, 12, { text: 'flood' }), true);
  assert.equal(calls.filter((c) => c[1] === 12).length, 2, '429 — один повтор');
  assert.equal(await ops.edit(1, 13, { text: 'gone' }), false);
  assert.match(logs.at(-1), /правка карточки: .*not found/);
  assert.equal(await ops.stale(1, 14, 'doc'), true);
  assert.deepEqual(calls.pop(), ['editMessageCaption', 14, STALE_TEXT]);
  assert.equal(await ops.stale(1, 15, 'text'), true);
  assert.deepEqual(calls.pop(), ['edit', 15, STALE_TEXT, false], 'пометка без кнопок');
});

test('retryFlood: короткий 429 — один повтор после retry_after; длинный 429 и другие ошибки — сразу наружу', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const flood = (s) => Object.assign(new Error('Too Many Requests'), { code: 429, retryAfter: s });
  let n = 0;
  assert.equal(await retryFlood(async () => { if (n++ === 0) throw flood(3); return 'ok'; }, { sleep }), 'ok');
  assert.deepEqual(waits, [3000]);
  n = 0;
  await assert.rejects(retryFlood(async () => { n++; throw flood(30); }, { sleep }), /Too Many/);
  assert.equal(n, 1, 'retry_after 30 с — без ожидания и повтора');
  n = 0;
  await assert.rejects(retryFlood(async () => { n++; throw flood(2); }, { sleep }), /Too Many/);
  assert.equal(n, 2, 'второй 429 подряд — наружу');
  n = 0;
  await assert.rejects(retryFlood(async () => { n++; throw new Error('fetch failed'); }, { sleep }), /fetch failed/);
  assert.equal(n, 1);
});
