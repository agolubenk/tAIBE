// Карточка пункта в Telegram — одно или несколько сообщений: длинное тело и блоки команд идут выше последнего, кнопки —
// у последнего. Бот помнит id всех сообщений карточки по id последнего, и 🔄 или итог действия обновляют их все
// (карточка HR nc8uj786, 22.10: агент поменял cmd пункта, а владелец мог скопировать старую команду из блока выше).
//
// Число сообщений то же — каждое правится на месте. Другое число или правка не удалась (сообщение удалено,
// разметка не принята) — старые сообщения карточки заменяются короткой пометкой без кнопок, свежая карточка
// приходит ниже. Старой команды на экране не остаётся.

/** Сколько карточек на чат помнит бот: старые забываются первыми. 🔄 на забытой правит только её последнее сообщение. */
export const CARDS_PER_CHAT = 100;
export const STALE_TEXT = '⤵️ Карточка обновлена — свежая версия ниже.';

/**
 * send(chatId, msg) → сообщение Telegram ({ message_id }) — с запасным путём для разметки, как в bot.mjs.
 * edit(chatId, id, msg) → true, если сообщение на месте теперь показывает msg (тот же текст — тоже true).
 */
export function createCards({ store, send, edit, now = Date.now }) {
  function book(chatId) {
    const all = store.state.cards || (store.state.cards = {});
    return all[chatId] || (all[chatId] = {});
  }

  function remember(chatId, ids) {
    const list = ids.filter(Boolean);
    if (!list.length) return;
    const b = book(chatId);
    b[list[list.length - 1]] = { ids: list, at: now() };
    const keys = Object.keys(b);
    if (keys.length > CARDS_PER_CHAT) {
      keys.sort((x, y) => b[x].at - b[y].at).slice(0, keys.length - CARDS_PER_CHAT).forEach((k) => { delete b[k]; });
    }
    store.saveState();
  }

  /** Новая карточка: все сообщения по порядку; id запоминаются. */
  async function sendCard(chatId, msgs) {
    const ids = [];
    for (const m of msgs) ids.push((await send(chatId, m))?.message_id);
    remember(chatId, ids);
    return ids;
  }

  /**
   * Обновить карточку, на последнем сообщении которой (lastId) нажали 🔄 или кнопку действия.
   * Возвращает { inPlace: true }, если все сообщения поправлены на месте, иначе { inPlace: false } — свежая карточка ниже.
   */
  async function refreshCard(chatId, lastId, msgs) {
    const b = book(chatId);
    const old = b[lastId]?.ids || [lastId];
    if (old.length === msgs.length) {
      let ok = true;
      for (let i = 0; i < msgs.length && ok; i++) ok = await edit(chatId, old[i], msgs[i]);
      if (ok) {
        remember(chatId, old);
        return { inPlace: true };
      }
    }
    for (const id of old) await edit(chatId, id, { text: STALE_TEXT });
    delete b[lastId];
    await sendCard(chatId, msgs);
    return { inPlace: false };
  }

  return { sendCard, refreshCard };
}
