#!/bin/bash
# Шаг 2. Бэкап: launchd-агенты, домашние папки агентов досок и бота, проверка свежего дампа базы досок,
# первый снимок вложенных репозиториев (бандлы со всеми ветками). Рабочие папки не меняются.
export STEP=2
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

for f in "$HOME"/Library/LaunchAgents/space.hrhelper.*.plist "$HOME"/Library/LaunchAgents/com.hrhelper.*.plist; do
  [ -e "$f" ] && cp -p "$f" "$BK/launchd/"
done
ok "plist агентов: $(find "$BK/launchd" -name '*.plist' | wc -l | tr -d ' ') файлов"
for d in .t-boards-notebook .t-boards-memory .t-boards-backup .hr-owner-queue-bot; do
  [ -d "$HOME/$d" ] && tar -C "$HOME" -czf "$BK/home/$d.tgz" "$d" && log "домашняя папка $d → home/$d.tgz"
done

dump="$(find "$HOME/t-boards-backups" -name 't-boards-*.dump' -mtime -1 2>/dev/null | head -1)"
if [ -z "$dump" ] && [ "${SPLIT_OWNER_OK_DUMP:-0}" != 1 ]; then
  stop "в ~/t-boards-backups нет дампа базы досок моложе суток — без свежей копии главных данных не продолжаем; владелец проверяет агент бэкапа (tail ~/t-boards-backups/pull.log). Продолжить без него: SPLIT_OWNER_OK_DUMP=1 bash $0"
fi
ok "свежий дамп базы досок: ${dump:-нет (разрешено владельцем)}"

S="$(bash "$SPLIT_DIR/scan.sh")"
log "снимок: $S"
sed 's/^/    /' "$S/summary.txt" | tee -a "$LOG"
grep -q 'БАНДЛ НЕ СОЗДАН' "$S/summary.txt" && stop "не создался бандл вложенного репозитория (см. summary.txt снимка)"
if grep -q 'НЕТ 799fae6' "$S/summary.txt" && [ "${SPLIT_OWNER_OK_799:-0}" != 1 ]; then
  stop "коммит 799fae6 (ветка fix/tb-notion-5xx-retry) не найден ни в одном бандле — владелец: где он сейчас? Продолжить: SPLIT_OWNER_OK_799=1 bash $0"
fi
log "неотправленные ветки: $(wc -l <"$S/unpushed.txt" | tr -d ' ') (перенос — в шаге 3)"
next "bash $SPLIT_DIR/3-prepare.sh"
