#!/usr/bin/env node
// Первичная настройка: создать бота у @BotFather через Telegram Web и привязать владельца.
// Владелец входит в Telegram Web в открывшемся окне (QR с телефона). Токен пишется только в
// ~/.hr-owner-queue-bot/config.json (600) и нигде не печатается. Затем владелец «пишет» новому боту
// /start <код> — бот привяжет его при первом запуске (апдейт ждёт в Telegram до 24 часов).
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, Store } from './store.mjs';

const NAME = process.env.OQB_BOT_NAME || 'HR Helper · очередь владельца';
const CANDIDATES = (process.env.OQB_BOT_USERNAMES || 'hrhelper_owner_queue_bot,hrh_owner_queue_bot').split(',')
  .concat([1, 2, 3].map(() => `hrh_queue_${Math.floor(1000 + Math.random() * 9000)}_bot`));
const TOKEN_RE = /\b(\d{8,11}:[A-Za-z0-9_-]{35})\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(new Date().toISOString(), s);

const store = new Store();
if (store.config.token && !process.argv.includes('--force')) {
  say('Токен уже есть в config.json — бот создан. Повторно: --force.');
  process.exit(0);
}

const ctx = await chromium.launchPersistentContext(join(HOME, 'tg-profile'), {
  channel: 'chrome', headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const input = () => page.locator('.input-message-input[contenteditable="true"]:not(.input-field-input-fake)').last();
const incoming = () => page.locator('.bubble.is-in');

async function openChat(username) {
  // Полная перезагрузка: смена одного hash оставляет на экране поле ввода прошлого чата,
  // и текст уходил туда (17.10 код привязки ушёл в @BotFather вместо нового бота).
  await page.goto('about:blank');
  await page.goto(`https://web.telegram.org/k/#@${username}`);
  await page.waitForSelector('.chat-info', { timeout: 60_000 });
  for (let i = 0; i < 60; i++) {
    const start = page.locator('.chat-input button').filter({ hasText: /^(start|начать|запустить|старт)$/i });
    if (await start.first().isVisible().catch(() => false)) {
      await start.first().click();
      await sleep(1500);
    }
    if (await input().isVisible().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`Не открылся чат @${username}`);
}

async function sendAndWait(text, patterns, timeoutMs = 45_000) {
  const before = await incoming().count();
  await input().click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(700);
    const n = await incoming().count();
    if (n > before) {
      const last = (await incoming().nth(n - 1).textContent()) || '';
      const hit = patterns.find((p) => p.re.test(last));
      if (hit) return { kind: hit.kind, text: last };
    }
  }
  throw new Error(`BotFather не ответил на шаг «${text.startsWith('/') ? text : 'ввод'}»`);
}

let done = false;
try {
  await page.goto('https://web.telegram.org/k/');
  say('Войдите в Telegram Web в открывшемся окне (QR-код: Telegram на телефоне → Настройки → Устройства → Подключить устройство). Жду до 15 минут…');
  await page.waitForSelector('ul.chatlist, .chatlist-container', { timeout: 15 * 60_000 });
  say('Вход выполнен. Создаю бота у @BotFather…');

  await openChat('BotFather');
  await sendAndWait('/cancel', [{ kind: 'any', re: /./ }]).catch(() => {});
  const step1 = await sendAndWait('/newbot', [
    { kind: 'name', re: /call it|choose a name|name for your bot|как назов/i },
    { kind: 'limit', re: /too many|can't add more|maximum|try again in/i },
  ]);
  if (step1.kind === 'limit') throw new Error('BotFather отказал: лимит ботов или попыток. Попробуйте позже.');
  await sendAndWait(NAME, [{ kind: 'username', re: /username/i }]);

  let username = null;
  for (const cand of CANDIDATES) {
    const r = await sendAndWait(cand, [
      { kind: 'token', re: TOKEN_RE },
      { kind: 'taken', re: /taken|invalid|sorry|занят/i },
    ]);
    if (r.kind === 'token') {
      store.config.token = r.text.match(TOKEN_RE)[1];
      store.saveConfig();
      username = cand;
      break;
    }
    say(`Имя @${cand} занято — пробую следующее`);
  }
  if (!username) throw new Error('Все варианты имени заняты — задайте OQB_BOT_USERNAMES=имя1_bot,имя2_bot');
  say(`Бот @${username} создан, токен сохранён в ${store.configPath} (права 600).`);

  // Описание бота — чтобы в Telegram было видно, что это.
  await sendAndWait('/setdescription', [{ kind: 'pick', re: /choose a bot|выберите/i }]).catch(() => null);
  await sendAndWait(`@${username}`, [{ kind: 'desc', re: /description|описание/i }]).catch(() => null);
  await sendAndWait('Личный бот владельца HR Helper: очередь решений, мёржей и проверок — зеркало страницы /queue ops-консоли.', [{ kind: 'ok', re: /success|updated|обновл/i }]).catch(() => null);

  const code = store.pairingCode();
  if (code) {
    await openChat(username);
    await input().click();
    await page.keyboard.insertText(`/start ${code}`);
    await page.keyboard.press('Enter');
    await sleep(2000);
    say('Код привязки отправлен боту от вашего имени — при первом запуске бот привяжет вас.');
  }
  say('Готово. Профиль Telegram Web удаляю; сессию «Chrome» завершите в Telegram → Настройки → Устройства.');
  done = true;
} catch (e) {
  say(`Ошибка: ${e.message}`);
  process.exitCode = 1;
} finally {
  await sleep(1500);
  await ctx.close();
  // Сессия личного Telegram владельца на диске не нужна после настройки.
  if (done) rmSync(join(HOME, 'tg-profile'), { recursive: true, force: true });
}
