#!/usr/bin/env node
// Telegram-бот «Очередь владельца»: страница очереди /queue в ops-консоли (переехала из артефакта claude.ai).
// Разделы, пункты, ответы (выбор, «Сделано», комментарий/вывод, «Изменить ответ»), «Ход работ», графики,
// живая сводка, поиск, уведомления, мёрж с деплоем и без, перезапуск деплоя. Ответы пишет сама страница.
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, Store } from './store.mjs';
import { TelegramApi } from './telegram.mjs';
import { ArtifactMirror, NotReadyError } from './mirror.mjs';
import { QueueApi } from './api.mjs';
import { createNotes } from './notes.mjs';
import { createWatcher } from './watch.mjs';
import { createInbox } from './inbox.mjs';
import { createFiles } from './files-setup.mjs';
/** id входящего, как его даёт черновик бота и форма /queue: i-<дата>-<время>-<4 hex>. */
const INBOX_ID = /^i-\d{8}-\d{6}-[0-9a-f]{4}$/;
import { hasMediaOf, isForwarded } from './classify.mjs';
import { toPlain } from './tg-html.mjs';
import {
  HELP, KINDS, btn, cut, esc, freshView, guideMessages, itemMessages, keyOf, menuFingerprint, menuView,
  nextOpen, optKey, searchView, sectionView, sshMessages, verOf, workMessages,
} from './view.mjs';

const WATCH_MS = Number(process.env.OQB_WATCH_SEC || 20) * 1000;
const STALL_MS = 10 * 60_000; // ни опроса Telegram, ни снимка дольше — процесс выходит, супервизор поднимет заново
const PAIR_MAX_FAILS = 10;
// Что делать, если страница открылась без входа: на Mac — войти в окне, на сервере — войти через VNC.
const HINT = process.env.OQB_RELOGIN_HINT || 'Проверьте, что ops-консоль доступна и токен бота (queueToken) не отозван: npm run oq -- token-list на сервере консоли.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store();
if (!store.config.token || !store.config.queueToken) {
  console.error(`Нужны токен Telegram (token) и токен очереди консоли (queueToken) в ${store.configPath} — README бота`);
  process.exit(2);
}
store.state.chats = store.state.chats || {};
const tg = new TelegramApi(store.config.token);
const log = (...a) => console.log(new Date().toISOString(), ...a.map((x) => tg.redact(x instanceof Error ? x.message : x)));
const mirror = new ArtifactMirror({
  profileDir: store.profileDir, url: store.config.artifactUrl, log,
  headless: process.env.OQB_HEADLESS === '1',
  channel: process.env.OQB_CHANNEL ?? 'chrome',
  sandbox: process.env.OQB_SANDBOX !== '0',
  token: store.config.queueToken,
});
const queueApi = new QueueApi({ url: store.config.artifactUrl, token: store.config.queueToken });

let last = null;
let pairFails = 0;
let conflicts = 0; // подряд 409: этот токен опрашивает другой процесс
const progress = { poll: Date.now(), watch: Date.now() };

const markup = (keyboard) => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
const errText = (e) => (e instanceof NotReadyError
  ? `⏳ ${esc(e.message)}. ${e.reason === 'auth' ? esc(HINT) : 'Повторите через минуту.'}`
  : `⚠️ ${esc(cut(tg.redact(e.message || String(e)), 300))}`);

async function snap() {
  last = await mirror.snapshot();
  return last;
}
const byKey = (s, key) => s?.items.find((it) => keyOf(it.id) === key);
const cardOf = (s, it) => itemMessages(it, { next: nextOpen(s, it) });

async function send(chatId, msg) {
  if (msg.document) return tg.sendDocument(chatId, msg.document.name, msg.document.text, msg.document.caption);
  try {
    return await tg.send(chatId, msg.text, markup(msg.keyboard));
  } catch (e) {
    if (!/can't parse entities/i.test(e.message)) throw e;
    return tg.call('sendMessage', { chat_id: chatId, text: toPlain(msg.text).slice(0, 4096), ...markup(msg.keyboard) });
  }
}

/** Правка сообщения на месте; если нельзя — новым сообщением. Возвращает id сообщения на экране. */
async function show(chatId, msg, editId) {
  if (editId) {
    try {
      await tg.edit(chatId, editId, msg.text, markup(msg.keyboard));
      return editId;
    } catch (e) {
      if (/can't parse entities/i.test(e.message)) {
        const ok = await tg.call('editMessageText', { chat_id: chatId, message_id: editId, text: toPlain(msg.text).slice(0, 4096), ...markup(msg.keyboard) }).then(() => true, () => false);
        if (ok) return editId;
      } else log('правка не удалась, шлю новым:', e.message);
    }
  }
  return (await send(chatId, msg))?.message_id;
}

const sendAll = async (chatId, msgs) => { for (const m of msgs) await send(chatId, m); };
async function broadcast(msg) {
  for (const id of store.config.owners) await send(id, msg).catch((e) => log('уведомление не ушло:', e.message));
}

const notes = createNotes({ tg, mirror, snap, send, log });

// Вложения входящих: лимиты консоли, очередь загрузок, режим «📎 Прикрепить файл» (files-setup.mjs).
const { getLimits, uploader, attach } = createFiles({ store, tg, queueApi, send, markup, log });

const inbox = createInbox({
  store, send, log, getLimits, uploader,
  show: (chatId, msg, editId) => show(chatId, msg, editId),
  putItem: (id, data, ifVersion) => queueApi.putItem(id, data, ifVersion),
  getItem: (id) => queueApi.getItem(id),
  relay: () => queueApi.relay(),
  alertBots: store.config.alertBots,
  // Свой пункт владельцу не объявляем «новым»: известен с момента записи (watch.mjs сравнивает с known).
  onSent: (id) => { if (store.state.known) { store.state.known[id] = { a: '', n: '' }; store.saveState(); } },
});
setInterval(() => inbox.prune(), 10 * 60_000).unref();
const SEARCH_TEXT_TTL_MS = 10 * 60_000;
const watcher = createWatcher({ store, tg, mirror, snap, broadcast, errText, hint: HINT, log, isStandby: () => conflicts >= 3 });

// ── Экраны ──────────────────────────────────────────────────────────────────
async function showMenu(chatId, editId) {
  const s = await snap();
  const id = await show(chatId, menuView(s, { notify: store.config.notify, hint: HINT }), editId);
  if (id) {
    store.state.chats[chatId] = { menu: id, fp: menuFingerprint(s) };
    store.saveState();
  }
}

const showSection = async (chatId, kind, page, showDone, editId) => {
  if (!KINDS[kind]) return send(chatId, { text: 'Нет такого раздела.' });
  return show(chatId, sectionView(await snap(), kind, { page, showDone }), editId);
};

async function openItem(chatId, key, editId) {
  const s = await snap();
  const it = byKey(s, key);
  if (!it) return send(chatId, { text: 'Пункт не найден — возможно, его убрали из очереди.', keyboard: [[btn('🏠 Меню', 'm')]] });
  const msgs = cardOf(s, it);
  if (editId) return show(chatId, msgs[msgs.length - 1], editId); // 🔄 на карточке — обновить ответ на месте
  return sendAll(chatId, msgs);
}

async function sendCharts(chatId) {
  await tg.call('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
  const shots = await mirror.screenshots();
  if (!shots.length) return send(chatId, { text: 'На странице нет графиков.' });
  await tg.sendPhotos(chatId, shots.map((s) => ({ buf: s.buf, caption: s.caption })));
  return send(chatId, { text: '📈 Графики, Гант и роадмап — как на странице артефакта.', keyboard: [[btn('📊 Ход работ текстом', 'w'), btn('🏠 Меню', 'm')]] });
}

// ── Действия владельца ──────────────────────────────────────────────────────
/**
 * Ответ на кнопку — сразу (Telegram ждёт ~15 с), итог — правкой карточки или сообщением.
 * Кнопка несёт версию содержимого пункта: если агент с тех пор поменял текст или варианты, действие не выполняется.
 */
async function doAction(q, key, op, arg, ver) {
  const chatId = q.message.chat.id;
  await tg.answer(q.id, 'Сохраняю…');
  let s = last || (await snap());
  let it = byKey(s, key);
  if (!it || (ver && verOf(it) !== ver)) { s = await snap(); it = byKey(s, key); }
  if (!it) return send(chatId, { text: 'Пункт не найден — возможно, его убрали из очереди.' });
  if (ver && verOf(it) !== ver) {
    await send(chatId, { text: '⚠️ Пункт изменился с тех пор, как был показан, — ответ не записан. Вот свежая версия:' });
    return sendAll(chatId, cardOf(s, it));
  }
  let value = arg;
  let expect;
  if (op === 'choose') {
    const o = it.options.find((x) => optKey(x.id) === arg);
    if (!o) return send(chatId, { text: 'Такого варианта уже нет — откройте пункт заново.' });
    value = o.id;
    expect = (d) => d.choice === o.id;
  } else if (op === 'done') expect = (d) => !!d.done === arg;
  else expect = (d) => !d.choice && !d.done;
  const res = await mirror.act(it.id, op, value, expect);
  if (!res.ok) return send(chatId, { text: `⚠️ ${esc(res.error)}` });
  log(`ответ: ${it.id} ${op}${op === 'choose' ? '=' + value : ''} ${res.confirmed ? 'подтверждён' : 'без подтверждения'}`);
  const s2 = await snap();
  const fresh = byKey(s2, key);
  if (fresh) {
    const msgs = cardOf(s2, fresh);
    const lastMsg = msgs[msgs.length - 1];
    const status = res.confirmed ? '' : '\n\n⏳ <i>Отправлено; подтверждение из общей базы ещё не пришло — нажмите 🔄 чуть позже.</i>';
    await show(chatId, { ...lastMsg, text: lastMsg.text + status }, q.message.message_id);
  }
  await watcher.refreshMenus(s2);
}

// ── Мёрж из очереди ─────────────────────────────────────────────────────────
/** Экран подтверждения: PR, SHA, последствие (деплой или нет), идёт ли деплой сейчас. */
async function mergeConfirm(chatId, key, ver) {
  const s = await snap();
  const it = byKey(s, key);
  if (!it) return send(chatId, { text: 'Пункт не найден — возможно, его убрали из очереди.' });
  if (ver && verOf(it) !== ver) {
    await send(chatId, { text: '⚠️ Пункт изменился с тех пор, как был показан. Вот свежая версия:' });
    return sendAll(chatId, cardOf(s, it));
  }
  const m = await queueApi.mergeInfo(it.id);
  // Консоль до проверки одобренной головы поля approval не отдаёт — тогда решает только сервер при мёрже.
  const approval = m.approval ?? 'ok';
  const what = m.skipCi ? 'без деплоя ([skip ci])' : m.deploys && m.baseRef === 'main' ? '<b>запустит деплой прода</b> (~3 минуты 502)' : 'деплой не ожидается';
  const lines = [
    `🚀 <b>Влить ${m.repo ? esc(m.repo) : 'PR '}#${m.pr}?</b>`,
    esc(m.title),
    `Коммит: <code>${esc(m.headSha.slice(0, 7))}</code> (${esc(m.headRef)} → ${esc(m.baseRef)})`,
    // Консоль до Q-30 способа не отдаёт — тогда это merge.
    `Способ: ${m.method === 'squash' ? 'squash — одним коммитом' : 'merge — коммитом слияния'}`,
    ...(m.subject ? [`Заголовок: <code>${esc(m.subject)}</code>`] : []),
    `Последствие: ${what}`,
  ];
  if (approval === 'missing') lines.push('⛔ Нет вердикта «Контроля» (поля sha и base в пункте) — вливать нельзя');
  if (approval === 'mismatch') lines.push(`⛔ Голова <code>${esc(m.headSha.slice(0, 7))}</code> — не та, что одобрил «Контроль» (<code>${esc(String(m.approvedSha).slice(0, 7))}</code>): нужен новый вердикт`);
  if (approval === 'base') lines.push(`⛔ «Контроль» одобрил PR для базы <code>${esc(String(m.approvedBase))}</code>, а сейчас база <code>${esc(m.baseRef)}</code>: нужен новый вердикт`);
  if (m.baseRef !== 'main') lines.push(`⚠️ База PR — <code>${esc(m.baseRef)}</code>, не main: прод не изменится, меняется эта ветка`);
  if (m.state !== 'open') lines.push(`⚠️ PR ${m.state === 'merged' ? 'уже влит' : 'закрыт'}`);
  if (m.mergeable === false) lines.push(`⚠️ GitHub: ${esc(m.mergeableState || 'конфликт')}`);
  if (m.deployRunning) lines.push(m.deploys && !m.skipCi ? '⏳ Сейчас идёт деплой — мёрж с деплоем станет доступен после него' : 'ℹ️ Сейчас идёт деплой');
  const blocked = approval !== 'ok' || m.state !== 'open' || m.mergeable === false || (m.deployRunning && m.deploys && !m.skipCi);
  return send(chatId, {
    text: lines.join('\n'),
    keyboard: [
      [...(blocked ? [] : [btn(`✅ Да, влить ${m.headSha.slice(0, 7)}`, `MY:${key}:${m.headSha}:${m.version}`)]), btn('✖️ Отмена', 'MN')],
      ...(/^https:\/\/github\.com\//.test(m.url) ? [[{ text: 'PR на GitHub', url: m.url }]] : []),
    ],
  });
}

/** ver — версия пункта с экрана подтверждения (callback «MY:<ключ 10>:<sha 40>:<версия>» — до 64 байт при версии до 9 цифр). */
async function mergeRun(chatId, key, sha, ver) {
  const it = byKey(last || (await snap()), key) || byKey(await snap(), key);
  if (!it) return send(chatId, { text: 'Пункт не найден.' });
  try {
    const r = await queueApi.merge(it.id, sha, /^\d+$/.test(ver || '') ? Number(ver) : undefined);
    log(`мёрж из Telegram: ${it.id} ${sha.slice(0, 7)}`);
    await send(chatId, { text: `✅ ${esc(r.message)}` });
  } catch (e) {
    return send(chatId, { text: `⚠️ ${esc(e.message)}` });
  }
  const s = await snap();
  const fresh = byKey(s, key);
  if (fresh) {
    const msgs = cardOf(s, fresh);
    await send(chatId, msgs[msgs.length - 1]);
  }
  await watcher.refreshMenus(s);
}

// ── Входящие ────────────────────────────────────────────────────────────────
const SECTION_CMD = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [`/${v.cmd}`, k]));

async function onStranger(chatId, uid, text) {
  const code = /^\/start\s+(\d{6})$/.exec(text);
  if (code && pairFails < PAIR_MAX_FAILS) {
    if (store.pair(uid, code[1])) {
      log('владелец привязан');
      await send(chatId, { text: `✅ Бот привязан к вам.\n\n${HELP}` });
      return showMenu(chatId);
    }
    pairFails++;
    log(`неверный код привязки от ${uid} (${pairFails}/${PAIR_MAX_FAILS})`);
    if (pairFails >= PAIR_MAX_FAILS) {
      store.resetPairing();
      log('привязка заблокирована до перезапуска; при перезапуске будет новый код');
    }
  } else log(`отказ: чужой пользователь ${uid}`);
  if (text.startsWith('/start')) await send(chatId, { text: 'Это личный бот владельца HR Helper.' });
}

async function onMessage(m) {
  if (m.chat?.type !== 'private') return;
  const chatId = m.chat.id;
  const text = (m.text || '').trim();
  if (!store.isOwner(m.from?.id)) return onStranger(chatId, m.from?.id, text);
  const cmd = text.split(/[\s@]/)[0];
  // Пересланное — всегда во входящие, раньше ввода в поле и команд: пересланный «/notify» — не команда,
  // а пересылка посреди ввода комментария не должна молча стать комментарием к чужому пункту.
  if (isForwarded(m)) {
    notes.cancel(chatId);
    inbox.cancelAppend(chatId);
    await attach.end(chatId, 'quiet');
    return inbox.start(chatId, m);
  }
  // Режим «📎 Прикрепить файл»: файлы и фото — к пункту (документ .txt тоже вложение, а не комментарий);
  // обычный текст режим завершает и идёт дальше как всегда.
  if (attach.active(chatId)) {
    if (hasMediaOf(m)) return attach.collect(chatId, m);
    if (text && !['/cancel'].includes(cmd)) await attach.end(chatId, 'quiet');
  }
  if (text && !text.startsWith('/') && inbox.appending(chatId)) return inbox.append(chatId, text);
  // В режиме ввода всё, кроме /cancel и /menu, — текст для поля (строка лога «/usr/lib/…» тоже).
  if (notes.active(chatId) && (m.document || (text && !['/cancel', '/menu', '/start'].includes(cmd)))) return notes.collect(chatId, m);
  // Фото посреди ввода в поле — не повод молча бросить ввод: поле принимает текст и файлы, фото — во входящие через /cancel.
  if (notes.active(chatId) && hasMediaOf(m)) {
    return send(chatId, { text: '📎 Фото в поле ответа не сохранить — опишите словами или пришлите файлом. Чтобы отправить фото во «Входящие», сначала /cancel.' });
  }
  notes.cancel(chatId);
  // Своё фото или файл вне ввода в поле — тоже во входящие (черновик с кнопками).
  if (hasMediaOf(m)) return inbox.start(chatId, m);
  if (SECTION_CMD[cmd]) return showSection(chatId, SECTION_CMD[cmd], 0, false);
  switch (cmd) {
    case '/start': case '/menu': return showMenu(chatId);
    case '/help': return sendAll(chatId, guideMessages(await snap()));
    case '/work': return sendAll(chatId, workMessages(await snap()));
    case '/charts': return sendCharts(chatId);
    case '/notify':
      store.config.notify = !store.config.notify;
      store.saveConfig();
      return send(chatId, { text: store.config.notify ? '🔔 Уведомления включены.' : '🔕 Уведомления выключены.' });
    case '/cancel': inbox.cancelAppend(chatId); await attach.end(chatId, 'cancel'); return send(chatId, { text: 'Ввод отменён.' });
    default:
      if (text && !text.startsWith('/')) {
        // Текст поиска помним 10 минут: кнопка «📥 Во входящие» под результатами превращает его в черновик.
        (store.state.searchText ||= {})[chatId] = { text, at: Date.now() };
        store.saveState();
        return show(chatId, searchView(await snap(), text));
      }
      return send(chatId, { text: 'Не понял. /menu — сводка, /help — что умеет бот.' });
  }
}

async function onCallback(q) {
  const chat = q.message?.chat;
  // Только личный чат самого владельца: клавиатура в пересланном или групповом сообщении не сработает.
  if (!chat || chat.type !== 'private' || chat.id !== q.from?.id || !store.isOwner(q.from.id)) return tg.answer(q.id, 'Нет доступа', true);
  const chatId = chat.id;
  const [t, a, b, c] = String(q.data || '').split(':');
  const msgId = q.message.message_id;
  let answered = false;
  const ack = async (text = '') => { answered = true; await tg.answer(q.id, text); };
  if (!['n', 'ns', 'nx', 'nc'].includes(t)) notes.cancel(chatId); // навигация закрывает незавершённый ввод
  // и «Дописать» тоже: иначе после кнопки с полем следующий текст ушёл бы в черновик, а не в ответ на пункт
  if (t !== 'ib') inbox.cancelAppend(chatId);
  try {
    switch (t) {
      case 'm': await ack(); return await showMenu(chatId, msgId);
      case 's': await ack(); return await showSection(chatId, a, Number(b) || 0, c === '1', msgId);
      case 'i': await ack(); return await openItem(chatId, a, b === 'r' ? msgId : null);
      case 'f': await ack(); return await show(chatId, freshView(await snap()), msgId);
      case 'ib': await ack(); return await inbox.onButton(chatId, msgId, a, b, c);
      // id пункта из кнопки — только формата входящих: в запросы консоли с токеном владельца не уходит чужая строка.
      case 'ibf': if (!INBOX_ID.test(a || '')) return await ack('Нет такого пункта'); await ack(); notes.cancel(chatId); return await attach.start(chatId, a);
      // Кнопка несёт пункт режима: старое сообщение режима к другому пункту текущий режим не закрывает.
      case 'ibfd': return await ack((await attach.end(chatId, 'done', a)) ? 'Готово' : 'Режим уже закрыт');
      case 'ibfx': return await ack((await attach.end(chatId, 'cancel', a)) ? 'Отменено' : 'Режим уже закрыт');
      case 'ibr': await ack(INBOX_ID.test(a || '') && uploader.retry(a) ? 'Повторяю' : 'Нечего повторять'); return;
      case 'ibn': {
        await ack();
        const st = store.state.searchText?.[chatId];
        if (!st || Date.now() - st.at > SEARCH_TEXT_TTL_MS) return await send(chatId, { text: 'Текст поиска уже забыт (10 минут). Пришлите его ещё раз.' });
        delete store.state.searchText[chatId];
        store.saveState();
        return await inbox.start(chatId, { text: st.text });
      }
      case 'h': await ack(); return await sendAll(chatId, sshMessages(await snap()));
      case 'v': await ack(); return await sendAll(chatId, guideMessages(await snap()));
      case 'M': await ack('Спрашиваю GitHub…'); return await mergeConfirm(chatId, a, b);
      case 'MY': await ack('Вливаю…'); return await mergeRun(chatId, a, b, c);
      case 'MN': case 'RN': await ack('Отменено'); return await show(chatId, { text: 'Отменено.' }, msgId);
      case 'RD':
        await ack();
        return await send(chatId, { text: '♻️ Запустить деплой main на прод заново? Около 3 минут сайт отвечает 502.', keyboard: [[btn('✅ Да, запустить деплой', 'RDY'), btn('✖️ Отмена', 'RN')]] });
      case 'RDY': {
        await ack('Запускаю…');
        const r = await queueApi.redeploy();
        log('деплой перезапущен из Telegram');
        return await show(chatId, { text: `♻️ ${esc(r.message)}. Ход — в ops-консоли, итог придёт уведомлением консоли.` }, msgId);
      }
      case 'o': answered = true; return await doAction(q, a, 'choose', b, c);
      case 'd': answered = true; return await doAction(q, a, 'done', b === '1', c);
      case 'r': answered = true; return await doAction(q, a, 'reopen', null, b);
      case 'n': {
        await ack();
        const it = byKey(last, a) || byKey(await snap(), a);
        return it ? await notes.start(chatId, it) : await send(chatId, { text: 'Пункт не найден.' });
      }
      case 'ns': await ack(); return await notes.saveBuffered(chatId);
      case 'nx': await ack(); return await notes.clear(chatId);
      case 'nc': notes.cancel(chatId); return await ack('Ввод отменён');
      case 'w': await ack(); return await sendAll(chatId, workMessages(await snap()));
      case 'g': await ack('Снимаю графики…'); return await sendCharts(chatId);
      case 't':
        store.config.notify = !store.config.notify;
        store.saveConfig();
        await ack(store.config.notify ? 'Уведомления включены' : 'Уведомления выключены');
        return await showMenu(chatId, msgId);
      default: return await ack();
    }
  } catch (e) {
    log('кнопка:', e);
    if (answered) await send(chatId, { text: errText(e) }).catch(() => {});
    else await tg.answer(q.id, toPlain(errText(e)).slice(0, 190), true);
  }
}

// ── Циклы ───────────────────────────────────────────────────────────────────
async function watchLoop() {
  for (;;) {
    await watcher.tick().catch((e) => log('фон:', e));
    progress.watch = Date.now(); // цикл жив (даже если снимок не удался) — сторож ловит только зависание
    await sleep(WATCH_MS);
  }
}

async function pollLoop() {
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates(store.state.offset || 0);
      progress.poll = Date.now();
      if (conflicts >= 3) log('другой процесс больше не опрашивает бота — продолжаю работу');
      conflicts = 0;
    } catch (e) {
      if (e.code === 409) {
        conflicts++;
        progress.poll = Date.now(); // ждём, а не висим
        if (conflicts === 3) log('этого бота опрашивает другой процесс: перехожу в ожидание (без уведомлений) — остановите второй экземпляр');
        await sleep(conflicts >= 3 ? 60_000 : 5_000);
      } else {
        log(`getUpdates: ${e.message}`);
        await sleep((e.retryAfter || 5) * 1000);
      }
      continue;
    }
    for (const u of updates) {
      store.state.offset = u.update_id + 1;
      store.saveState();
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        log('обработка:', e);
        const chatId = u.message?.chat?.id;
        if (chatId && store.isOwner(u.message.from?.id)) await send(chatId, { text: errText(e) }).catch(() => {});
      }
    }
  }
}

async function main() {
  const pidFile = join(HOME, 'bot.pid');
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const stop = async (code = 0) => {
    try { unlinkSync(pidFile); } catch { /* уже нет */ }
    await mirror.stop();
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  // Сторож: если ни опрос Telegram, ни снимок страницы не продвигались 10 минут — выходим, супервизор поднимет.
  setInterval(() => {
    const stalled = Date.now() - Math.min(progress.poll, progress.watch);
    if (stalled > STALL_MS) { log(`работа встала на ${Math.round(stalled / 60000)} мин — перезапуск процесса`); stop(1); }
  }, 60_000).unref();

  log('старт: открываю артефакт в браузере бота…');
  // Сбой первого запуска браузера не фатален: очередь зеркала перезапустит его на следующей операции.
  await mirror.start().catch((e) => { mirror.broken = true; log('браузер не поднялся с первого раза:', e); });
  const me = await tg.call('getMe');
  await tg.call('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Сводка и разделы' },
      { command: 'decisions', description: 'Решения' },
      { command: 'merges', description: 'Мёржи' },
      { command: 'server', description: 'На сервере' },
      { command: 'checks', description: 'Проверить руками' },
      { command: 'inbox', description: 'Входящие: пересланное вами' },
      { command: 'work', description: 'Ход работ: показатели и отчёт' },
      { command: 'charts', description: 'Графики, Гант и роадмап' },
      { command: 'notify', description: 'Уведомления вкл/выкл' },
      { command: 'help', description: 'Что умеет бот' },
    ],
  });
  const code = store.pairingCode();
  if (code) log(`владелец не привязан: откройте https://t.me/${me.username}?start=${code} и нажмите «Начать»`);
  else log(`бот @${me.username} готов, владельцев: ${store.config.owners.length}`);
  // Вложения, недогруженные до перезапуска: очередь в state, временные файлы — в каталоге бота.
  uploader.kick().catch((e) => log('очередь файлов не продолжилась:', e));
  watchLoop();
  await pollLoop();
}

main().catch(async (e) => {
  log('фатально:', e);
  await mirror.stop();
  process.exit(1);
});
