// Зеркало очереди: Chromium под Playwright держит страницу /queue ops-консоли открытой (токен бота —
// заголовком, только в запросы к консоли). Все вызовы к странице — по очереди,
// у каждого потолок времени; зависший или упавший браузер перезапускается.
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import {
  actOnItem, installChecksWatch, isQueueFrame, readCheck, saveErrorOf, setShotLayout, snapshotPage,
} from './frame-scripts.mjs';
import { releaseStaleProfileLock } from './profile-lock.mjs';

export class NotReadyError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_TIMEOUT = 45_000;

export class ArtifactMirror {
  constructor({ profileDir, url, headless = false, channel = 'chrome', sandbox = true, token = '', log = console.log }) {
    Object.assign(this, { profileDir, url, headless, channel, sandbox, token });
    this.log = typeof log === 'function' ? log : (...a) => log?.log?.(...a);
    this.ctx = null;
    this.page = null;
    this.cachedFrame = null;
    this.queue = Promise.resolve();
    this.openedAt = 0;
    this.generation = 0; // растёт при каждой загрузке страницы — фон по нему пропускает «холодный» снимок
    this.broken = false;
    // Имя подписки во фрейме — случайное: страница не может заранее подложить «подтверждения».
    this.watchKey = '__oqb_' + randomBytes(6).toString('hex');
  }

  async launch() {
    // Прошлый браузер мог быть убит без закрытия (новый контейнер, OOM) — его замок не даст стартовать.
    releaseStaleProfileLock(this.profileDir, { log: this.log });
    return chromium.launchPersistentContext(this.profileDir, {
      ...(this.channel ? { channel: this.channel } : {}), // пусто — встроенный Chromium (контейнер на сервере)
      headless: this.headless,
      chromiumSandbox: this.sandbox,
      viewport: { width: 1400, height: 2000 },
      locale: 'ru-RU',
      timezoneId: process.env.TZ || 'Europe/Moscow',
      ignoreDefaultArgs: ['--enable-automation'],
    });
  }

  async start() {
    this.broken = false;
    try {
      this.ctx = await this.launch();
    } catch (e) {
      // Ядро хоста может запрещать пространства имён (AppArmor в Ubuntu 23.10+) — тогда без песочницы
      // Chromium, но с ограничениями контейнера (не root, без capabilities, read-only). Пишем громко.
      if (!this.sandbox || !/sandbox|zygote/i.test(e.message)) throw e;
      this.sandbox = false;
      this.log('ВНИМАНИЕ: песочница Chromium недоступна на этом хосте — работаю без неё (изоляция только контейнером)');
      this.ctx = await this.launch();
    }
    if (this.sandbox) this.log('песочница Chromium включена');
    const ctx = this.ctx;
    await this.attachToken(ctx);
    ctx.on('close', () => { if (this.ctx === ctx) { this.broken = true; this.log('браузер закрылся — перезапущу'); } });
    this.page = this.watchCrash(ctx.pages()[0] || (await ctx.newPage()));
    await this.open();
  }

  watchCrash(page) {
    page.on('crash', () => { if (this.page === page) { this.broken = true; this.log('вкладка упала — перезапущу браузер'); } });
    return page;
  }

  /**
   * Новая вкладка вместо старой. Playwright держит в процессе Node объекты запросов, ответов и маршрутов
   * вкладки, пока она открыта (до 10 000 каждого вида), а страница опрашивает консоль раз в 4 с — каждый
   * запрос проходит через маршрут с токеном. Перезагрузка в той же вкладке их не отпускает, закрытие — да.
   */
  async freshPage() {
    const old = this.page;
    this.page = this.watchCrash(await this.ctx.newPage());
    await old?.close().catch(() => {});
  }

  /**
   * Токен очереди — заголовком Authorization, и только в запросы к самой консоли: страница грузит ещё
   * шрифты Google, им токен знать незачем.
   */
  async attachToken(ctx) {
    if (!this.token) return;
    const origin = new URL(this.url).origin;
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (new URL(req.url()).origin !== origin) return route.continue();
      return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${this.token}` } });
    });
  }

  async open() {
    this.cachedFrame = null;
    this.dataSeen = false;
    this.openedAt = Date.now();
    this.generation++;
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  async stop() {
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close().catch(() => {});
  }

  /** Перезапуск браузера вне очереди — для зависшей или упавшей страницы. */
  async restart(reason) {
    this.log(`перезапуск браузера: ${reason}`);
    await this.stop();
    await this.start();
  }

  /**
   * Все обращения к странице по одному, у каждого потолок времени. Таймаут — значит страница зависла:
   * браузер помечается сломанным и перезапускается перед следующей операцией.
   */
  run(fn, timeoutMs = OP_TIMEOUT) {
    const task = async () => {
      if (this.broken || !this.ctx) {
        try { await this.restart(this.ctx ? 'страница не отвечала или упала' : 'браузер не запущен'); } catch (e) {
          this.broken = true;
          throw new NotReadyError(`Браузер бота не запускается: ${e.message}`, 'browser');
        }
      }
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new NotReadyError('Страница очереди /queue не ответила вовремя', 'timeout')), timeoutMs); });
      try {
        return await Promise.race([fn(), timeout]);
      } catch (e) {
        if (e instanceof NotReadyError && e.reason === 'timeout') this.broken = true;
        if (/Target page, context or browser has been closed|Target crashed/i.test(e.message)) this.broken = true;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async findFrame(timeoutMs = 30_000) {
    if (this.cachedFrame && !this.cachedFrame.isDetached()) return this.cachedFrame;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      for (const f of this.page.frames()) {
        if (await f.evaluate(isQueueFrame).catch(() => false)) {
          this.cachedFrame = f;
          return f;
        }
      }
      await sleep(1000);
    }
    if (/\/login/.test(this.page.url())) {
      throw new NotReadyError('Консоль не приняла токен бота (страница очереди открылась на входе)', 'auth');
    }
    throw new NotReadyError('Страница очереди /queue не открылась', 'frame');
  }

  /** Фрейм с подключённой базой и отрисованным «Ходом работ» (страница рисует его в requestAnimationFrame). */
  async readyFrame() {
    const f = await this.findFrame();
    for (let i = 0; i < 20; i++) {
      const st = await f.evaluate(() => ({
        mode: document.getElementById('mode')?.dataset.mode,
        dash: !!document.getElementById('dash-asof')?.textContent,
      })).catch(() => null);
      if (st && st.mode && st.mode !== 'pending' && st.dash) break;
      await sleep(500);
    }
    // Первый ответ API приходит позже отрисовки: снимок до него — только вшитые пункты («Сделано 0 из 46»).
    // Ждём пункты из базы, но не дольше 10 с после загрузки (пустая база — тоже ответ).
    if (!this.dataSeen) {
      const until = this.openedAt + 10_000;
      while (Date.now() < until) {
        if (await f.evaluate(() => !!document.querySelector('.item[data-src="db"]')).catch(() => false)) break;
        await sleep(300);
      }
      this.dataSeen = true;
    }
    return f;
  }

  snapshot() {
    return this.run(async () => {
      try {
        return await (await this.readyFrame()).evaluate(snapshotPage);
      } catch (e) {
        if (e instanceof NotReadyError || this.broken) throw e;
        // Фрейм пересоздан (переиздание артефакта) — одна повторная попытка с поиском заново.
        this.cachedFrame = null;
        return (await this.readyFrame()).evaluate(snapshotPage);
      }
    });
  }

  /**
   * Действие владельца через элементы страницы. Возвращает { ok, confirmed, error }.
   * confirmed — в общей базе checks/<id> появилась НОВАЯ запись (сменилось поле at) и она совпадает
   * с ожидаемой: повторное нажатие уже отмеченного варианта не засчитывается по старым данным.
   */
  act(id, op, value, expect) {
    return this.run(async () => {
      const f = await this.readyFrame();
      const key = this.watchKey;
      await f.evaluate(installChecksWatch, key).catch(() => false);
      // Базовая линия — только из пришедшего снимка базы, иначе старая запись сошла бы за подтверждение.
      let before = null;
      for (let i = 0; i < 10 && !before?.ready; i++) {
        before = await f.evaluate(readCheck, { key, id }).catch(() => null);
        if (!before?.ready) await sleep(200);
      }
      const errBefore = await f.evaluate(saveErrorOf, id).catch(() => false);
      const res = await f.evaluate(actOnItem, { id, op, value });
      if (!res.ok) return res;
      const started = Date.now();
      while (Date.now() - started < 6_000) {
        await sleep(400);
        const err = await f.evaluate(saveErrorOf, id).catch(() => false);
        // Старая метка ошибки от прошлой неудачи держится до успешной записи — первые 3 с её не считаем.
        if (err && (!errBefore || Date.now() - started > 3_000)) {
          // Ответ уже изменён в другом месте (страница /queue, другая вкладка) — повтор старого его не перепишет
          // (ревью «Контроля» #324, п. 1). Артефакт заморожен с 18.10 — отвечать на странице /queue.
          return String(err).includes('изменён в другом месте')
            ? { ok: false, error: 'Ответ уже изменён в другом месте — сохранён тот, что новее. Откройте пункт ещё раз.' }
            : { ok: false, error: 'Страница не смогла сохранить ответ в общую базу. Повторите или ответьте на странице /queue.' };
        }
        const c = await f.evaluate(readCheck, { key, id }).catch(() => null);
        if (before?.ready && c?.data && c.data.at !== before.data?.at && expect(c.data)) return { ok: true, confirmed: true };
      }
      return { ok: true, confirmed: false };
    });
  }

  /** Скриншоты карточек «Ход работ» (графики, Гант, роадмап) — как их видит владелец. */
  screenshots() {
    return this.run(async () => {
      const f = await this.readyFrame();
      await f.evaluate(setShotLayout, true);
      try {
        await sleep(600); // ResizeObserver страницы перерисует графики под новую ширину
        const out = [];
        const kpis = f.locator('#kpis');
        if (await kpis.count()) out.push({ caption: 'Ход работ: показатели', buf: await kpis.screenshot({ animations: 'disabled' }) });
        const cards = f.locator('#agents .card');
        const n = await cards.count();
        for (let i = 0; i < n; i++) {
          const card = cards.nth(i);
          const title = ((await card.locator('h3').first().textContent().catch(() => '')) || '').trim();
          if (/^Отчёт/.test(title)) continue; // таблица — текстом в «Ход работ»
          out.push({ caption: title, buf: await card.screenshot({ animations: 'disabled' }) });
        }
        return out;
      } finally {
        await f.evaluate(setShotLayout, false).catch(() => {});
      }
    }, 120_000);
  }

  /** Свежая загрузка страницы в новой вкладке: профилактика раз в час и после сбоев. */
  reload() {
    return this.run(async () => {
      await this.freshPage();
      await this.open();
    }, 90_000);
  }
}
