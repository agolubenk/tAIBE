#!/bin/bash
# Откат переключения (только по решению владельца): убрать ссылки, вернуть папки из бэкапа, вернуть состояние Нерва,
# запустить Нерв и синк блокнота, перезапустить агрегатор хаба. Ничего не удаляет, кроме самих ссылок.
export STEP=rollback
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

has launchctl && launchctl bootout "$(gui)/space.hrhelper.nerve" 2>/dev/null
cd "$HR" || stop "нет $HR"
for l in supertick-eval eval boards t-boards/app; do
  if [ -L "$l" ]; then rm "$l" && log "ссылка убрана: $l"; fi
done
[ -d t-boards ] && [ -z "$(ls -A t-boards)" ] && rmdir t-boards
for d in supertick-eval t-boards tAIBoard_and_Eval; do
  if [ -e "$BK/moved/$d" ]; then
    [ -e "$d" ] && stop "$HR/$d уже существует — не затираю; разобраться руками"
    mv "$BK/moved/$d" "$d" && log "возвращено: $d"
  fi
done
if [ -d "$TB/eval/nerve/state" ] && [ -d supertick-eval/nerve/state ]; then
  cp -Rp "$TB/eval/nerve/state/." supertick-eval/nerve/state/ && log "состояние Нерва возвращено из tAIBE"
  rm -f supertick-eval/nerve/state/nerve.lock
fi
for x in /supertick-eval /eval /boards /t-boards/ /.claude/pipeline-settings.json; do
  grep -vxF -- "$x" .git/info/exclude >.git/info/exclude.tmp 2>/dev/null && mv .git/info/exclude.tmp .git/info/exclude
done
if has launchctl; then
  launch_agent space.hrhelper.nerve 2>>"$LOG" && log "Нерв запущен"
  # Синк блокнота шлёт то, что числит git HR, и удаляет из блокнота остальное. Если PR очистки уже в HEAD, git HR
  # не числит вернувшиеся папки — включённый синк удалил бы их документы с сервера. Тогда синк остаётся на паузе.
  if git -C "$HR" cat-file -e HEAD:t-boards 2>/dev/null; then
    [ -f "$HOME/Library/LaunchAgents/space.hrhelper.t-boards-notebook-sync.plist" ] &&
      launch_agent space.hrhelper.t-boards-notebook-sync 2>>"$LOG" && log "синк блокнота запущен"
  else
    warn "синк блокнота оставлен на паузе: PR очистки уже в HR, включённый синк удалил бы документы t-boards из блокнота (решение владельца)"
  fi
fi
[ -f infra/scripts/dev-ai/mcp-hub.sh ] && bash infra/scripts/dev-ai/mcp-hub.sh restart hub >>"$LOG" 2>&1
log "откат сделан. Если PR очистки уже в main, git HR покажет вернувшиеся папки неотслеживаемыми — работе не мешает; вернуть их в git — revert PR очистки (решение владельца)."
exit 0
