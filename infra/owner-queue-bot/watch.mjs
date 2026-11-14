// Фон: новые пункты и статусы агентов → уведомления; связь со страницей → предупреждения; живая сводка.
import { agentNotice, backNotice, localNotice, menuFingerprint, menuView, newItemsNotice } from './view.mjs';

// Раз в час — свежая вкладка (mirror.freshPage): за час опросов Playwright копит ~3 тыс. объектов запросов
// вместо потолка в 10 тыс. Сама загрузка — пара секунд, действия владельца ждут её в общей очереди.
const RELOAD_MS = 3600_000;
const LOCAL_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000]; // перезагрузка, пока страница без базы

// Выкатка консоли — 1–2 мин без ответа: страница сама возвращается к общей базе (подмена базы повторяет снимок), и
// владельцу молчим. Связи нет дольше — сигнал; консоль не приняла токен (401/403) — сразу: сам он не вернётся.
export const LOCAL_GRACE_MS = 180_000;

export function createWatcher({ store, tg, mirror, snap, broadcast, errText, hint, log, isStandby, now = Date.now }) {
  let failStreak = 0;
  let lastMode = null;
  let lastGen = 0;
  let localSince = 0;
  let localReloads = 0;
  const alerted = { ready: false, local: false };
  const markup = (keyboard) => ({ reply_markup: { inline_keyboard: keyboard } });

  /** Последнее меню в каждом чате правится, когда меняются прогресс и счётчики. */
  async function refreshMenus(s) {
    const fp = menuFingerprint(s);
    let view = null;
    for (const [chatId, c] of Object.entries(store.state.chats || {})) {
      if (!c?.menu || c.fp === fp || !store.isOwner(chatId)) continue;
      view = view || menuView(s, { notify: store.config.notify, hint });
      try {
        await tg.edit(chatId, c.menu, view.text, markup(view.keyboard));
        c.fp = fp;
      } catch (e) {
        // Забываем меню, только если его больше нельзя править; 429 и сеть — попробуем на следующем тике.
        if (/message to edit not found|can't be edited|message_id_invalid/i.test(e.message)) delete c.menu;
      }
    }
    store.saveState();
  }

  /**
   * Страница без базы — консоль не ответила на опрос (недоступна, токен отозван, перезапуск при выкатке). Владельцу —
   * одно сообщение с причиной и временем последнего удачного ответа (s.conn); страница перезагружается с нарастающей
   * паузой.
   */
  async function onLocal(s) {
    const t = now();
    if (!localSince) { localSince = t; localReloads = 0; }
    const wait = LOCAL_BACKOFF_MS[Math.min(localReloads, LOCAL_BACKOFF_MS.length - 1)];
    const auth = !!s.conn && (s.conn.status === 401 || s.conn.status === 403);
    if (!alerted.local && (auth || t - localSince >= LOCAL_GRACE_MS)) {
      alerted.local = true;
      const nextReloadMs = Math.max(LOCAL_BACKOFF_MS[0], localSince + wait * (localReloads + 1) - t);
      await broadcast(localNotice(s.conn, { now: t, nextReloadMs, hint }));
    }
    if (t - localSince >= wait * (localReloads + 1)) {
      localReloads++;
      await mirror.reload().catch((e) => log('перезагрузка:', e));
    }
    return s;
  }

  async function tick() {
    if (now() - mirror.openedAt > RELOAD_MS) await mirror.reload().catch((e) => log('перезагрузка:', e));
    let s;
    try {
      s = await snap();
    } catch (e) {
      failStreak++;
      log('снимок не удался:', e);
      if (failStreak >= 4 && !alerted.ready && !isStandby()) {
        alerted.ready = true;
        await broadcast({ text: errText(e) });
      }
      if (failStreak % 6 === 3) await mirror.reload().catch(() => {});
      return;
    }
    failStreak = 0;
    if (s.mode !== lastMode) { log(`режим страницы: ${s.mode}`); lastMode = s.mode; }
    if (isStandby()) return; // этого бота опрашивает другой процесс — уведомления шлёт он
    if (alerted.ready) { alerted.ready = false; await broadcast({ text: '✅ Связь с артефактом восстановлена.' }); }
    if (s.mode === 'local') return onLocal(s);
    if (localSince && s.mode === 'shared') {
      if (alerted.local) { alerted.local = false; await broadcast(backNotice(now() - localSince)); }
      localSince = 0;
    }
    if (s.mode !== 'shared') return;

    // Первый снимок после загрузки страницы может прийти без пунктов из базы и статусов агентов —
    // по нему не сравниваем и известное не меняем, иначе после каждой перезагрузки шли бы ложные уведомления.
    if (mirror.generation !== lastGen) {
      lastGen = mirror.generation;
      if (store.state.known) return refreshMenus(s);
    }
    const known = store.state.known;
    const next = { ...(known || {}) }; // дополняем: пункт, временно пропавший из снимка, не станет «новым»
    s.items.forEach((it) => { next[it.id] = { a: it.agentStatus || '', n: it.agentNote || '' }; });
    if (known && store.config.notify) {
      const fresh = s.items.filter((it) => !known[it.id] && !it.done);
      if (fresh.length) await broadcast(newItemsNotice(fresh));
      const moved = s.items.filter((it) => known[it.id] && it.agentStatus && (known[it.id].a !== it.agentStatus || known[it.id].n !== (it.agentNote || '')));
      for (const it of moved.slice(0, 5)) await broadcast(agentNotice(it));
    }
    if (JSON.stringify(known) !== JSON.stringify(next)) {
      store.state.known = next;
      store.saveState();
    }
    await refreshMenus(s);
  }

  return { tick, refreshMenus };
}
