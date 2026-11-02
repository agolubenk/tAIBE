#!/bin/bash
# Шаг 1. Предполётная проверка — ничего не меняет. Пройдена — код 0; иначе СТОП (3) с причиной.
export STEP=1
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"
log "начало: HR=$HR TB=$TB BK=$BK"

[ -x "$PY" ] || stop "нет Python Нерва: $PY (/usr/bin/python3 на этой машине — шим Xcode)"
log "python: $("$PY" --version 2>&1)"
has git || stop "нет git"
has node || stop "нет node (нужен для сборки MCP досок)"
major="$(node -v | sed 's/^v//; s/\..*//')"
[ "$major" -ge "${SPLIT_MIN_NODE:-24}" ] || stop "node $(node -v): нужен 24.11 или новее"
free_gb="$(df -k "$HOME" | awk 'NR==2 {print int($4/1024/1024)}')"
[ "$free_gb" -ge "${SPLIT_MIN_FREE_GB:-20}" ] || stop "свободно ${free_gb} ГБ, нужно не меньше 20"
ok "инструменты: node $(node -v), свободно ${free_gb} ГБ"

# --- HR
[ -d "$HR/.git" ] || stop "нет checkout'а HR: $HR"
[ -L "$HR/supertick-eval" ] && stop "в HR supertick-eval уже ссылка — разделение уже делали? (см. $LOG)"
[ -d "$HR/supertick-eval" ] || stop "в HR нет папки supertick-eval"
[ -d "$HR/t-boards" ] || stop "в HR нет папки t-boards"
br="$(git -C "$HR" rev-parse --abbrev-ref HEAD)"
[ "$br" = main ] || stop "checkout HR на ветке $br, нужен main"
git -C "$HR" fetch -q origin || stop "git fetch в HR не прошёл (сеть, доступ к GitHub)"
ahead="$(git -C "$HR" rev-list --count origin/main..HEAD)"
[ "$ahead" = 0 ] || stop "в HR $ahead локальных коммитов не отправлены в main: $(git -C "$HR" log --oneline origin/main..HEAD | head -5 | tr '\n' ';') — владелец: отправить их (git push origin main) или решить иначе"
log "HR отстаёт от origin/main на $(git -C "$HR" rev-list --count HEAD..origin/main) коммитов (подтянется в шаге 5)"
git -C "$HR" -c core.quotepath=off status --porcelain >"$BK/patches/hr-status-before.txt"
ok "HR на main, неотправленных коммитов нет; незакоммиченных строк: $(wc -l <"$BK/patches/hr-status-before.txt" | tr -d ' ') (список — patches/hr-status-before.txt, их не трогаем)"

# --- tAIBE
[ -d "$TB/.git" ] || stop "нет checkout'а tAIBE: $TB (его клонирует первая команда исполнителя)"
git -C "$TB" fetch -q origin || stop "git fetch в tAIBE не прошёл"
[ "$(git -C "$TB" rev-parse --abbrev-ref HEAD)" = board-agents ] || stop "tAIBE не на ветке board-agents"
[ -z "$(git -C "$TB" status --porcelain)" ] || stop "в checkout'е tAIBE есть правки: $(git -C "$TB" status --short | head -3 | tr '\n' ';')"
git -C "$TB" merge -q --ff-only origin/board-agents || stop "tAIBE не обновляется до origin/board-agents"
"$PY" -I - "$TB/eval/nerve/config.json" "$HR" <<'EOF' || stop "eval/nerve/config.json tAIBE не про этот checkout HR (вывод выше)"
import json, sys
cfg = json.load(open(sys.argv[1]))
want = {"repo_root": sys.argv[2], "product_tree": "supertick-eval"}
bad = {k: cfg.get(k) for k, v in want.items() if cfg.get(k) != v}
if cfg.get("github", {}).get("repo") != "agolubenk/HR_Helper-v2":
    bad["github.repo"] = cfg.get("github", {}).get("repo")
print("config.json:", "ok" if not bad else bad)
sys.exit(1 if bad else 0)
EOF
ok "tAIBE на board-agents ($(git -C "$TB" log --oneline -1)), конфиг Нерва смотрит на этот HR"

# --- launchd
if has launchctl; then
  launchctl list | grep -E 'hrhelper|t-boards' >"$BK/launchd/before.txt" || true
  ok "агенты launchd до начала: $(wc -l <"$BK/launchd/before.txt" | tr -d ' ') (launchd/before.txt)"
else
  warn "нет launchctl (не macOS?) — список агентов не снят"
  : >"$BK/launchd/before.txt"
fi
grep -l -E 'HR_Helper-v2/(t-boards|supertick-eval)' "$HOME"/Library/LaunchAgents/*.plist 2>/dev/null >"$BK/launchd/tied.txt" || true
log "агенты с путями в переезжающие папки: $(tr '\n' ' ' <"$BK/launchd/tied.txt")"

# --- ветки HR, которые меняют переезжающие папки: их мёрж после разделения вернёт настоящие папки на место ссылок
: >"$BK/patches/hr-branches-touching.txt"
for b in $(git -C "$HR" for-each-ref --format='%(refname:short)' refs/remotes/origin); do
  case "$b" in origin/main | origin/HEAD | origin) continue ;; esac
  n="$(git -C "$HR" log --oneline "origin/main..$b" -- supertick-eval t-boards 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] && echo "$b: $n коммитов" >>"$BK/patches/hr-branches-touching.txt"
done
if [ -s "$BK/patches/hr-branches-touching.txt" ] && [ "${SPLIT_OWNER_OK_BRANCHES:-0}" != 1 ]; then
  stop "ветки HR меняют supertick-eval/ или t-boards/: $(tr '\n' ';' <"$BK/patches/hr-branches-touching.txt") — владелец: их нельзя вливать после разделения, пока правки не перенесены в tAIBE. Продолжить: SPLIT_OWNER_OK_BRANCHES=1 bash $0"
fi

next "bash $SPLIT_DIR/2-backup.sh"
