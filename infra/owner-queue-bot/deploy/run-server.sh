#!/usr/bin/env bash
# Сборка и запуск бота на сервере (владелец запускает по ssh). Отдельный контейнер вне стека HR Helper:
# прод-деплой не нужен, сервисы продукта не трогаются. Повторный запуск — обновление кода, данные сохраняются.
#   /opt/owner-queue-bot/src  — папка infra/owner-queue-bot (код, Dockerfile, deploy/)
#   /opt/owner-queue-bot/data — config.json (токен Telegram, queueToken консоли, владелец), state.json, профиль браузера
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ROOT=/opt/owner-queue-bot
DATA="$ROOT/data"
IMAGE=owner-queue-bot:latest
NAME=owner-queue-bot
NET=owner-queue-bot

[ -s "$DATA/config.json" ] || { echo "Нет $DATA/config.json — README бота, шаг 3"; exit 1; }
grep -q '"queueToken"' "$DATA/config.json" || { echo "В config.json нет queueToken — README бота, шаг 2"; exit 1; }

echo "== сборка образа (первый раз — несколько минут)"
docker build -q -t "$IMAGE" "$SRC" >/dev/null
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"

chmod 700 "$ROOT"
chown -R "$uid:$uid" "$DATA"
chmod 700 "$DATA"
find "$DATA" -maxdepth 1 -type f -exec chmod 600 {} +

# Своя сеть: бот изолирован от контейнеров продукта, в консоль ходит по публичному адресу (TLS, nginx).
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# Сначала штатная остановка: бот по SIGTERM закрывает браузер, и Chromium снимает замок профиля. rm -f сразу
# убивал его (SIGKILL) — замок оставался, и новый контейнер не запускал браузер (20.10). Остаток замка бот
# снимет и сам (profile-lock.mjs), но так надёжнее.
docker stop -t 30 "$NAME" >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Лимит памяти 2 ГБ: на 1 ГБ ядро убивало Chromium в контейнере (15.11, OPS-76). Лимит — потолок, а не резерв:
# если хосту не хватит памяти, `--oom-score-adj 500` делает бота первой жертвой ядра вместо процесса продукта.
# Свободная память хоста — до запуска; swap = лимит: свопа у контейнера нет, общий диск он не грузит.
MEM_MB=2048
mem="$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true)"
case "$mem" in
  '' | *[!0-9]*) echo "!! память хоста неизвестна (нет MemAvailable в /proc/meminfo), лимит бота ${MEM_MB} МБ" ;;
  *)
    echo "== свободно памяти хоста: ${mem} МБ, лимит бота ${MEM_MB} МБ"
    [ "$mem" -ge "$MEM_MB" ] || echo "!! свободной памяти меньше лимита бота: при пике ядро будет убивать бота — передайте это число Контролю"
    ;;
esac

docker run -d --name "$NAME" --restart unless-stopped --init \
  --network "$NET" \
  --memory "${MEM_MB}m" --memory-swap "${MEM_MB}m" --oom-score-adj 500 --cpus 1 --pids-limit 512 --shm-size 256m \
  --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges \
  --security-opt seccomp="$SRC/deploy/seccomp-chromium.json" \
  --read-only --tmpfs /tmp:rw,nosuid,size=256m -e HOME=/tmp \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v "$DATA":/data \
  "$IMAGE" >/dev/null

echo "== контейнер запущен, жду 40 с"
sleep 40
docker logs --tail 15 "$NAME" 2>&1 | sed -E 's/start=[0-9]+/start=******/'
# Песочница Chromium: сильнее изолирует страницу от токена и профиля в /data. Если ядро её не даёт — видно здесь.
docker logs "$NAME" 2>&1 | grep -E 'песочница' | tail -1 || true
docker stats --no-stream --format '{{.Name}}: память {{.MemUsage}}, CPU {{.CPUPerc}}' "$NAME"
