# Бот «Очередь владельца» на сервере: открывает страницу очереди ops-консоли (/queue) в headless Chromium
# с токеном бота и работает её же кнопками; мёрж и деплой — через API консоли. Портов нет: бот сам ходит
# в Telegram и в консоль. Только Chromium (не все браузеры образа Playwright): меньше диска на VPS.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund --ignore-scripts playwright@1.64.0 \
 && npx playwright install --with-deps --no-shell chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /tmp/* \
 && useradd --create-home --uid 1001 bot

COPY *.mjs ./

ENV OQB_HOME=/data \
    OQB_CHANNEL=chromium \
    OQB_HEADLESS=1 \
    TZ=Europe/Moscow \
    NODE_ENV=production

USER bot
# Куча Node — 256 МБ, а не авто-предел от лимита контейнера (растёт с лимитом): в том же контейнере работает Chromium,
# и вместе они упирались в лимит памяти.
CMD ["node", "--max-old-space-size=256", "bot.mjs"]
