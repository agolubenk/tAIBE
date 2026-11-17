// Подтверждение ответа владельца по ответу консоли на запись checks/<id> (OPS-76).
// Страница сохраняет ответ запросом PATCH/PUT /api/oq/v1/db/checks/<id> (page-scripts.ts), консоль возвращает
// сохранённую запись целиком. Ответ сети видит Playwright, а не код страницы. Без Playwright — для тестов.

const CHECKS_PATH = '/api/oq/v1/db/checks/';
export const SAVE_WAIT_MS = 6_000;
export const CHANGED_ELSEWHERE = 'Ответ уже изменён в другом месте — сохранён тот, что новее. Откройте пункт ещё раз.';
export const SAVE_FAILED = 'Страница не смогла сохранить ответ в общую базу. Повторите или ответьте на странице /queue.';

export const pathOf = (url) => { try { return decodeURIComponent(new URL(url).pathname); } catch { return ''; } };

/**
 * Слушать ответы консоли на запись checks/<id> с этой минуты: подписка — до нажатия, иначе быстрый ответ пропадёт.
 * result(expect, ms) → { ok, confirmed, error }: confirmed — консоль сохранила запись, и она совпала с expect.
 * Страница могла отправить и прежнюю правку того же пункта (своя очередь записей) — ждём совпадающую до срока.
 */
export function watchSave(page, id) {
  const path = CHECKS_PATH + id;
  const writes = [];
  let wake = null;
  const onResponse = (r) => {
    const m = r.request().method();
    if ((m === 'PATCH' || m === 'PUT') && pathOf(r.url()) === path) { writes.push(r); wake?.(); }
  };
  page.on('response', onResponse);
  return {
    async result(expect, ms = SAVE_WAIT_MS) {
      const until = Date.now() + ms;
      while (Date.now() < until || writes.length) {
        if (!writes.length) {
          await new Promise((r) => {
            const timer = setTimeout(r, Math.max(0, until - Date.now()));
            wake = () => { clearTimeout(timer); r(); };
          });
          wake = null;
          continue;
        }
        const r = writes.shift();
        // Ответ уже изменён в другом месте (страница /queue, другая вкладка) — повтор старого его не перепишет
        // (ревью «Контроля» #324, п. 1). Артефакт заморожен с 18.10 — отвечать на странице /queue.
        if (r.status() === 409) return { ok: false, error: CHANGED_ELSEWHERE };
        if (!r.ok()) return { ok: false, error: SAVE_FAILED };
        const doc = await r.json().catch(() => null);
        if (doc?.data && expect(doc.data)) return { ok: true, confirmed: true };
      }
      return { ok: true, confirmed: false };
    },
    stop() { page.off('response', onResponse); },
  };
}
