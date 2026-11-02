#!/bin/bash
# Шаг 5b (после мёржа PR очистки): убрать папки из HR в бэкап, подтянуть main, поставить ссылки на tAIBE, скрыть
# их в .git/info/exclude, запустить Нерв и перезапустить агрегатор хаба.
export STEP=5b
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

git -C "$HR" fetch -q origin main || stop "git fetch HR не прошёл"
if git -C "$HR" cat-file -e origin/main:supertick-eval 2>/dev/null || git -C "$HR" cat-file -e origin/main:t-boards 2>/dev/null; then
  wait_owner "PR очистки HR ещё не влит в main ($(cat "$BK/hr-pr-url" 2>/dev/null)). После мёржа: bash $0"
fi
p="$(nerve_procs)"
[ -z "$p" ] || stop "процессы Нерва/тапов снова живы: $(printf '%s' "$p" | tr '\n' ';') — закрыть сессии, затем bash $SPLIT_DIR/5a-freeze.sh"

cd "$HR" || stop "нет $HR"
moved=""
for d in supertick-eval t-boards tAIBoard_and_Eval; do
  if [ -e "$d" ] && [ ! -L "$d" ] && [ ! -L "$d/app" ]; then
    [ -e "$BK/moved/$d" ] && stop "в бэкапе уже есть $BK/moved/$d — разобраться, прежде чем переносить снова"
    mv "$d" "$BK/moved/$d" || stop "не перенеслась папка $d"
    moved="$moved $d"
  fi
done
log "в бэкап перенесены:${moved:- ничего (уже были перенесены)}"

if ! git pull -q --ff-only origin main; then
  for d in $moved; do mv "$BK/moved/$d" "$HR/$d"; done
  stop "git pull --ff-only в HR не прошёл — папки возвращены на место; вывод git выше (обычно мешает локальная правка того же файла)"
fi
git -c core.quotepath=off status --porcelain | grep -qE '(supertick-eval|t-boards)' &&
  stop "после pull git HR всё ещё видит supertick-eval/t-boards: $(git status --short | grep -E 'supertick-eval|t-boards' | head -3 | tr '\n' ';')"
ok "HR на $(git log --oneline -1), пути сняты с учёта"

[ -e supertick-eval ] || ln -s "$TB/eval" supertick-eval
[ -e eval ] || ln -s "$TB/eval" eval
[ -e boards ] || ln -s "$TB/boards" boards
mkdir -p t-boards
[ -e t-boards/app ] || ln -s "$TB/boards" t-boards/app
for l in supertick-eval eval boards t-boards/app; do
  [ -L "$l" ] || stop "$HR/$l не ссылка"
  [ -e "$l/" ] || stop "ссылка $HR/$l никуда не ведёт"
done
for x in /supertick-eval /eval /boards /t-boards/ /.claude/pipeline-settings.json; do
  grep -qxF -- "$x" .git/info/exclude 2>/dev/null || echo "$x" >>.git/info/exclude
done
git -c core.quotepath=off status --porcelain | grep -qE '^\?\? (supertick-eval|eval|boards|t-boards)' &&
  stop "git HR показывает ссылки — .git/info/exclude не сработал"
ok "ссылки: supertick-eval, eval → $TB/eval; boards, t-boards/app → $TB/boards (скрыты в .git/info/exclude)"

if has launchctl; then
  launchctl bootstrap "$(gui)" "$HOME/Library/LaunchAgents/space.hrhelper.nerve.plist" 2>>"$LOG" || stop "Нерв не запустился (launchctl bootstrap)"
  sleep 10
  launchctl print "$(gui)/space.hrhelper.nerve" 2>/dev/null | grep -qE 'state = running' || stop "Нерв не в состоянии running: $(launchctl print "$(gui)/space.hrhelper.nerve" 2>&1 | grep -E 'state|last exit' | tr '\n' ' ')"
  ok "Нерв запущен из tAIBE (plist тот же: путь supertick-eval теперь ведёт в tAIBE)"
fi
before="$(cat "$BK/state/nerve.log.size" 2>/dev/null || echo 0)"
now=0; [ -f "$TB/eval/nerve/state/nerve.log" ] && now="$(wc -c <"$TB/eval/nerve/state/nerve.log" | tr -d ' ')"
if [ "${now:-0}" -gt "${before:-0}" ]; then
  tail -c $((now - before)) "$TB/eval/nerve/state/nerve.log" | tail -5 | tee -a "$LOG"
  stop "Нерв пишет ошибки в nerve.log после запуска (выше) — откат: bash $SPLIT_DIR/rollback.sh"
fi
ok "nerve.log без новых ошибок"

if [ -f infra/scripts/dev-ai/mcp-hub.sh ]; then
  bash infra/scripts/dev-ai/mcp-hub.sh restart hub >>"$LOG" 2>&1 || warn "restart hub вернул ошибку (см. журнал)"
  bash infra/scripts/dev-ai/mcp-hub.sh check >>"$LOG" 2>&1 && ok "MCP-хаб: check ok" || warn "MCP-хаб: check не прошёл (см. журнал) — проверить в шаге 6"
fi
next "bash $SPLIT_DIR/6-verify.sh"
