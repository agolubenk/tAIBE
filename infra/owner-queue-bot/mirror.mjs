// Зеркало очереди: Chromium под Playwright держит страницу /queue ops-консоли открытой (токен бота —
// заголовком, только в запросы к консоли). Все вызовы к странице — по очереди,
// у каждого потолок времени; зависший или упавший браузер перезапускается.
import { chromium } from 'playwright';
import { actOnItem, isQueueFrame, setShotLayout, settled, snapshotPage } from './frame-scripts.mjs';
import { releaseStaleProfileLock } from './profile-lock.mjs';
import { watchSave } from './save-confirm.mjs';

export class NotReadyError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP_TIMEOUT = 45_000;
// Операция дольше — строка в лог: сколько ждала очереди и сколько шла сама (разбор медленного бота, OPS-76).
const SLOW_OP_MS = 2_000;

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
  run(fn, timeoutMs = OP_TIMEOUT, name = 'операция') {
    const queued = Date.now();
    const task = async () => {
      const started = Date.now();
      try {
        return await this.exec(fn, timeoutMs);
      } finally {
        const done = Date.now();
        if (done - queued > SLOW_OP_MS) this.log(`медленно: ${name} ${done - queued} мс (ждала очереди ${started - queued} мс, шла ${done - started} мс)`);
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  async exec(fn, timeoutMs) {
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

  /**
   * Снимок страницы. ids — только эти пункты (items), остальное — как в полном снимке: после ответа бот обновляет
   * один пункт, а не разбирает тела всех пунктов страницы (при CPU x4 полный снимок 300 пунктов — 0,14 с, 800 — 0,33 с).
   */
  snapshot(ids = null) {
    return this.run(async () => {
      try {
        return await (await this.readyFrame()).evaluate(snapshotPage, ids);
      } catch (e) {
        if (e instanceof NotReadyError || this.broken) throw e;
        // Фрейм пересоздан (переиздание артефакта) — одна повторная попытка с поиском заново.
        this.cachedFrame = null;
        return (await this.readyFrame()).evaluate(snapshotPage, ids);
      }
    }, OP_TIMEOUT, ids ? 'снимок пункта' : 'снимок');
  }

  /**
   * Действие владельца через элементы страницы. Возвращает { ok, confirmed, error }.
   * confirmed — консоль ответила на запись checks/<id>, которую страница отправила после нажатия, и сохранённая
   * запись (консоль возвращает её целиком) совпадает с ожидаемой. Ответ сети видит Playwright, а не код страницы.
   * Раньше бот ждал свою подписку на checks/ (до 2 с базовой линии и опрос раз в 400 мс после следующего опроса
   * страницы): при CPU x4 ответ занимал 1,1–3,3 с (замер OPS-76, 15.11).
   */
  act(id, op, value, expect) {
    return this.run(async () => {
      const f = await this.readyFrame();
      const save = watchSave(this.page, id); // до нажатия: ответ консоли может прийти раньше, чем вернётся evaluate
      try {
        const res = await f.evaluate(actOnItem, { id, op, value });
        if (!res.ok) return res;
        const out = await save.result(expect);
        // Страница отрисовала сохранённое — снимок после act его увидит.
        if (out.confirmed) await f.evaluate(settled).catch(() => {});
        return out;
      } finally {
        save.stop();
      }
    }, OP_TIMEOUT, 'ответ');
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
    }, 120_000, 'графики');
  }

  /** Свежая загрузка страницы в новой вкладке: профилактика раз в час и после сбоев. */
  reload() {
    return this.run(async () => {
      await this.freshPage();
      await this.open();
    }, 90_000, 'перезагрузка');
  }
}
