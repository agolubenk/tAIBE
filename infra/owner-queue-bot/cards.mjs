// Карточка пункта в Telegram — одно или несколько сообщений: длинное тело, блоки команд и файлы длинных команд (.sh)
// идут выше последнего, кнопки — у последнего. Бот помнит id и вид (текст или файл) всех сообщений карточки по id
// последнего, и 🔄 или итог действия обновляют их все (карточка HR nc8uj786, 22.10: агент поменял cmd пункта, а
// владелец мог скопировать старую команду из блока выше).
//
// Число и виды сообщений те же — каждое правится на месте: текст — новым текстом, файл — новым файлом. Иначе или если
// правка не удалась (сообщение удалено, лимит Telegram) — сначала приходит свежая карточка ниже, потом старые
// сообщения получают короткую пометку без кнопок (у файла — подписью). Пока свежая карточка не отправлена, старая
// остаётся как была, с кнопками, и бот её помнит: следующий 🔄 повторит обновление целиком.
import { retryFlood } from './telegram.mjs';

/** Сколько карточек на чат помнит бот: старые забываются первыми. 🔄 на забытой знает только её последнее сообщение. */
export const CARDS_PER_CHAT = 100;
export const STALE_TEXT = '⤵️ Карточка обновлена — свежая версия ниже.';

/** Вид сообщения карточки: 'doc' — файл ({ document }), 'text' — текст. */
export const kindOf = (msg) => (msg?.document ? 'doc' : 'text');

/**
 * send(chatId, msg) → сообщение Telegram ({ message_id }); бросает, если не отправлено.
 * edit(chatId, id, msg) → true, если сообщение на месте теперь показывает msg (тот же текст — тоже true); того же вида.
 * stale(chatId, id, kind) → пометка STALE_TEXT без кнопок: у текста — текстом, у файла — подписью; true, если удалось.
 */
export function createCards({ store, send, edit, stale, now = Date.now }) {
  function book(chatId) {
    const all = store.state.cards || (store.state.cards = {});
    return all[chatId] || (all[chatId] = {});
  }

  function remember(chatId, ids, kinds) {
    if (!ids.length || ids.some((id) => !id)) return;
    const b = book(chatId);
    b[ids[ids.length - 1]] = { ids, kinds, at: now() };
    const keys = Object.keys(b);
    if (keys.length > CARDS_PER_CHAT) {
      keys.sort((x, y) => b[x].at - b[y].at).slice(0, keys.length - CARDS_PER_CHAT).forEach((k) => { delete b[k]; });
    }
    store.saveState();
  }

  /** Новая карточка: все сообщения по порядку; id и виды запоминаются. Сбой отправки — исключение наружу. */
  async function sendCard(chatId, msgs) {
    const ids = [];
    for (const m of msgs) ids.push((await send(chatId, m))?.message_id);
    remember(chatId, ids, msgs.map(kindOf));
    return ids;
  }

  /**
   * Обновить карточку, на последнем сообщении которой (lastId) нажали 🔄 или кнопку действия.
   * Возвращает { inPlace: true }, если все сообщения поправлены на месте, иначе { inPlace: false } — свежая карточка ниже.
   * Свежая карточка не ушла (лимит, сеть) — исключение наружу, старая карточка и её запись не тронуты.
   */
  async function refreshCard(chatId, lastId, msgs) {
    const b = book(chatId);
    const rec = b[lastId];
    // Незнакомая карточка (старше памяти, отправлена до обновления бота) — известно только последнее сообщение, оно
    // всегда текст с кнопками.
    const old = rec?.ids || [lastId];
    const oldKinds = rec?.kinds || old.map(() => 'text');
    const kinds = msgs.map(kindOf);
    if (old.length === msgs.length && kinds.every((k, i) => k === oldKinds[i])) {
      let ok = true;
      for (let i = 0; i < msgs.length && ok; i++) ok = await edit(chatId, old[i], msgs[i]);
      if (ok) {
        remember(chatId, old, kinds);
        return { inPlace: true };
      }
    }
    await sendCard(chatId, msgs);
    for (let i = 0; i < old.length; i++) await stale(chatId, old[i], oldKinds[i]);
    if (b[lastId]) {
      delete b[lastId];
      store.saveState();
    }
    return { inPlace: false };
  }

  return { sendCard, refreshCard };
}

/**
 * edit и stale для createCards поверх TelegramApi бота. Каждый вызов — с одним повтором после короткого 429
 * (retryFlood); «can't parse entities» у текста — простым текстом, как у show в bot.mjs. Ошибка — false и строка в журнал.
 */
export function telegramCardOps({ tg, markup, toPlain, sleep, log }) {
  const editText = async (chatId, id, text, keyboard) => {
    try {
      await tg.edit(chatId, id, text, markup(keyboard));
    } catch (e) {
      if (!/can't parse entities/i.test(e.message)) throw e;
      await tg.call('editMessageText', { chat_id: chatId, message_id: id, text: toPlain(text).slice(0, 4096), ...markup(keyboard) });
    }
  };
  const attempt = (what, fn) => retryFlood(fn, { sleep }).then(() => true, (e) => { log(`${what}:`, e.message); return false; });
  return {
    edit: (chatId, id, msg) => attempt('правка карточки', () => (msg.document
      ? tg.editDocument(chatId, id, msg.document.name, msg.document.text, msg.document.caption)
      : editText(chatId, id, msg.text, msg.keyboard))),
    stale: (chatId, id, kind) => attempt('пометка старой карточки', () => (kind === 'doc'
      ? tg.call('editMessageCaption', { chat_id: chatId, message_id: id, caption: STALE_TEXT })
      : tg.edit(chatId, id, STALE_TEXT))),
  };
}
