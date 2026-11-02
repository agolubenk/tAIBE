# shellcheck shell=bash
# Общее для шагов разделения HR / tAIBE на Mac владельца (docs/ops/split-hr-taibe.md).
# Пишется под bash 3.2 (системный на macOS): без ассоциативных массивов, без пустых массивов под set -u.
#
# Коды выхода шагов: 0 — шаг пройден, следующий назван в последней строке;
#                    3 — СТОП, нужен ответ владельца (причина в строке «СТОП:»);
#                    4 — ЖДЁМ ВЛАДЕЛЬЦА (его действие названо в строке «ЖДЁМ:»);
#                    1 — ошибка скрипта.
set -u

: "${HR:=$HOME/Desktop/Development/HR_Helper-v2}"
: "${TB:=$HOME/Desktop/Development/tAIBE}"
: "${BK:=$HOME/Backups/split-2026-11-02}"
: "${PY:=/Library/Frameworks/Python.framework/Versions/3.14/bin/python3}"
export HR TB BK PY

# shellcheck disable=SC2034  # читают шаги, которые подключают этот файл
SPLIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034
HR_BRANCH="chore/split-t-boards-supertick"
# shellcheck disable=SC2034
HR_WT="$HR/worktrees/chore/split-t-boards"
# shellcheck disable=SC2034
HR_REPO="agolubenk/HR_Helper-v2"

mkdir -p "$BK/patches" "$BK/moved" "$BK/launchd" "$BK/home" "$BK/state"
chmod 700 "$BK"  # в бэкапе будут ключи (~/.t-boards-notebook/api_key и т. п.)
LOG="$BK/LOG.md"

log() { printf '%s [шаг %s] %s\n' "$(date '+%H:%M:%S')" "${STEP:-?}" "$*" | tee -a "$LOG"; }
ok() { log "ok: $*"; }
warn() { log "ВНИМАНИЕ: $*"; }
stop() {
  log "СТОП: $*"
  printf '\n=== СТОП. Ничего не исправлять самому: показать владельцу строку «СТОП» выше и ждать ответа. ===\n'
  exit 3
}
wait_owner() {
  log "ЖДЁМ: $*"
  printf '\n=== ЖДЁМ ВЛАДЕЛЬЦА. Передать ему строку «ЖДЁМ» выше, дальше — только после его ответа. ===\n'
  exit 4
}
next() {
  log "ГОТОВО. Следующая команда: $*"
  exit 0
}

has() { command -v "$1" >/dev/null 2>&1; }
gui() { printf 'gui/%s' "$(id -u)"; }

# Запустить агента launchd по метке: уже загружен — перезапуск (kickstart -k), иначе bootstrap из ~/Library/LaunchAgents.
# Повторный bootstrap загруженного агента на macOS падает («Bootstrap failed: 5»), поэтому так.
launch_agent() {
  if launchctl print "$(gui)/$1" >/dev/null 2>&1; then
    launchctl kickstart -k "$(gui)/$1"
  else
    launchctl bootstrap "$(gui)" "$HOME/Library/LaunchAgents/$1.plist"
  fi
}

# Живые процессы Нерва, его тапов у сессий и роя (пусто — всё остановлено).
nerve_procs() { pgrep -fl 'nerve\.py|swarm\.py' 2>/dev/null || true; }

# Последний снимок scan.sh (папка с summary.txt, unpushed.txt …).
last_scan() { cat "$BK/last-scan" 2>/dev/null || true; }
