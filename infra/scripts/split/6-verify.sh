#!/bin/bash
# Шаг 6. Проверка после переключения: печатает таблицу PASS/FAIL автоматических проверок и список ручных.
# Любой FAIL — СТОП (откат — rollback.sh, решение владельца).
export STEP=6
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

fails=0
row() { # row <номер> <что> <команда…>
  n="$1"
  what="$2"
  shift 2
  if out="$("$@" 2>&1)"; then
    printf '| %s | %s | PASS |\n' "$n" "$what" | tee -a "$LOG"
  else
    printf '| %s | %s | FAIL: %s |\n' "$n" "$what" "$(printf '%s' "$out" | tail -2 | tr '\n' ' ' | cut -c1-160)" | tee -a "$LOG"
    fails=$((fails + 1))
  fi
}
c_genome() { "$PY" -I "$TB/eval/pipeline/genome/build.py" --check; }
c_spawn() {
  cd "$HR" || return 1
  local n
  n="$(bash supertick-eval/tools/spawn_session.sh --launch --roles all --terminal print --dry-run | grep -c -- '--settings')"
  [ "$n" = 6 ] || { echo "геномов в командах: $n из 6"; return 1; }
}
c_hooks() {
  cd "$HR" || return 1
  local t bad=""
  for t in .claude/hooks/test_*.py; do "$PY" "$t" >/dev/null 2>&1 || bad="$bad $t"; done
  [ -z "$bad" ] || { echo "$bad"; return 1; }
}
c_nerve() { # status всегда выходит с 0 — смотрим, что демон жив: heartbeat моложе 5 минут (интервал 60 с)
  "$PY" -I "$HR/eval/nerve/nerve.py" status >/dev/null 2>&1 || return 1
  [ -n "$(find "$TB/eval/nerve/state/heartbeat" -mmin -5 2>/dev/null)" ] || { echo "heartbeat старше 5 минут или нет"; return 1; }
}
c_tap() { "$PY" -I "$HR/eval/nerve/nerve.py" tap selftest --once >/dev/null; }
c_tied() {
  local f p bad=""
  while read -r f; do
    [ -n "$f" ] || continue
    while read -r p; do
      case "$p" in "" | */state/* | *.log) continue ;; esac
      [ -e "$p" ] || bad="$bad [$p]"
    done <<EOP
$(plutil -p "$f" 2>/dev/null | grep -oE '/Users/[^"<]+')
EOP
  done <"$BK/launchd/tied.txt"
  [ -z "$bad" ] || { echo "нет путей:$bad"; return 1; }
}
c_tunnel() { ifconfig 2>/dev/null | grep -q 'inet 10\.77\.0\.'; }
c_boards() { [ "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' https://d4dev.admin.hrhelper.space/api/health)" = 200 ]; }
c_ops() { curl -sS -m 10 https://ops.admin.hrhelper.space/api/health | grep -q '"ok":true'; }
c_hub() { cd "$HR" && bash infra/scripts/dev-ai/mcp-hub.sh check; }
c_agents() {
  has launchctl || return 0
  local now
  now="$(launchctl list | grep -E 'hrhelper|t-boards' | awk '{print $3}' | sort)"
  local was
  was="$(awk '{print $3}' "$BK/launchd/before.txt" | grep -v 't-boards-notebook-sync' | sort)"
  local miss
  miss="$(comm -23 <(printf '%s\n' "$was") <(printf '%s\n' "$now"))"
  [ -z "$miss" ] || { echo "пропали агенты: $miss"; return 1; }
}
c_notebook() {
  local r
  r="$("$PY" -c 'import json,os;print(json.load(open(os.path.expanduser("~/.t-boards-notebook/config.json")))["repoRoot"])' 2>/dev/null)" || return 0
  [ "$r" = "$HR" ] || { echo "repoRoot блокнота: $r"; return 1; }
}
c_backup() { ! tail -1 "$HOME/t-boards-backups/pull.log" 2>/dev/null | grep -q FAILED; }
c_git() {
  [ -z "$(git -C "$HR" -c core.quotepath=off status --porcelain | grep -E '^.. "?(supertick-eval|t-boards|eval|boards)(/|$|")')" ] || return 1
  git -C "$TB" status --short >"$BK/state/tb-status-after.txt"
}

echo "| # | Проверка | Итог |" | tee -a "$LOG"
echo "|---|---|---|" | tee -a "$LOG"
row 1 "геномы ролей сходятся" c_genome
row 2 "запуск ролей из HR находит 6 геномов" c_spawn
row 3 "тесты хуков HR" c_hooks
row 4 "Нерв отвечает (status)" c_nerve
row 5 "тап проверочной роли (курсоры сессий не трогает)" c_tap
row 6 "launchd-агенты с путями в старые папки — пути существуют" c_tied
row 7 "туннель WireGuard (10.77.0.x)" c_tunnel
row 8 "доски d4dev /api/health = 200" c_boards
row 9 "ops-консоль /api/health" c_ops
row 10 "MCP-хаб check" c_hub
row 11 "агенты launchd те же, что до (кроме синка блокнота)" c_agents
row 12 "блокнот смотрит в checkout HR" c_notebook
row 13 "последний бэкап базы досок без FAILED" c_backup
row 14 "git HR без переезжающих путей; список правок tAIBE снят" c_git

cat <<EOF | tee -a "$LOG"

Ручные проверки (сделать в сессии Claude, запущенной из $HR):
  15. любой инструмент t-boards из хаба (например, список продуктов) — доски отвечают;
  16. oq_list checks — очередь владельца отвечает.
Неотслеживаемые файлы, перенесённые в tAIBE (показать владельцу): $BK/state/tb-status-after.txt
EOF
[ "$fails" = 0 ] || stop "не прошло проверок: $fails (строки FAIL выше). Откат — bash $SPLIT_DIR/rollback.sh, только по решению владельца"
next "ручные проверки 15–16, затем отчёт владельцу (раздел «Отчёт» инструкции). Сессии команды владелец запускает как обычно."
