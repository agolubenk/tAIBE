#!/bin/bash
# LaunchAgent автоуборки сессий Claude Code (space.hrhelper.reaper, раз в 30 мин) — ставит и снимает только владелец.
#   bash eval/tools/reaper_launchd.sh print [--apply]      показать plist, ничего не ставить
#   bash eval/tools/reaper_launchd.sh install [--apply]    поставить: без --apply — сухо (только журнал), с --apply — снимает
#   bash eval/tools/reaper_launchd.sh uninstall            снять (откат)
#   --dry-run — install/uninstall только печатают, что сделали бы
# Код запускается из основного checkout слоя (не из worktree): поставить можно после мёржа lineage_auto.py.
# Свои проекты — основной checkout слоя и repo_root из eval/nerve/config.json; ещё — --root DIR.
# Журнал решений — ~/.claude/lineage/reap-auto.jsonl, ошибки — ~/.claude/lineage/reaper.err.log.
# Первый запуск: macOS спросит, может ли python3 управлять Terminal (окна закрываются через osascript).
set -euo pipefail
LABEL=space.hrhelper.reaper
TOOLS="$(cd "$(dirname "$0")" && pwd -P)"
MAIN="$(git -C "$TOOLS" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')" || MAIN=""
[ -n "$MAIN" ] || { echo "reaper_launchd: не git checkout: $TOOLS" >&2; exit 2; }
TOP="$(git -C "$TOOLS" rev-parse --show-toplevel)"
TREE="${TOOLS#"$TOP"/}"   # eval/tools (или supertick-eval/tools в инстансе над хостом); из worktree — тот же путь в основном
RUN="$MAIN/$TREE"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
LIN="${TAIBE_LINEAGE_DIR:-$HOME/.claude/lineage}"

cmd="${1:-}"; shift || true
APPLY=0 DRY=0 ROOTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --root) ROOTS+=("${2:?}"); shift 2 ;;
    *) echo "reaper_launchd: неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

xml() { case "$1" in *[\<\>\&]*) echo "reaper_launchd: символ < > & в пути: $1" >&2; exit 2 ;; esac; printf '%s' "$1"; }

render() {
  local py host args a
  py="$(command -v python3)" || { echo "reaper_launchd: нет python3" >&2; exit 2; }
  host="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repo_root") or "")' \
    "$MAIN/${TREE%/tools}/nerve/config.json" 2>/dev/null)" || host=""
  args=("$py" -I "$RUN/lineage.py" reap --auto)
  [ -n "$host" ] && [ -d "$host" ] && args+=(--root "$host")
  for a in ${ROOTS[@]+"${ROOTS[@]}"}; do args+=(--root "$a"); done
  [ "$APPLY" = 1 ] && args+=(--apply)
  local items=""
  for a in "${args[@]}"; do items="$items    <string>$(xml "$a")</string>
"; done
  local tpl
  tpl="$(cat "$TOOLS/$LABEL.plist")"
  tpl="${tpl//@ARGS@/${items%$'\n'}}"
  tpl="${tpl//@TOOLS@/$(xml "$RUN")}"
  tpl="${tpl//@PATH@/$(xml "$(dirname "$py"):/usr/bin:/bin:/usr/sbin:/sbin")}"
  tpl="${tpl//@ERRLOG@/$(xml "$LIN/reaper.err.log")}"
  printf '%s\n' "$tpl"
}

case "$cmd" in
  print)
    render ;;
  install)
    [ -f "$RUN/lineage_auto.py" ] || { echo "reaper_launchd: в основном checkout нет $RUN/lineage_auto.py — сначала мёрж" >&2; exit 2; }
    if [ "$DRY" = 1 ]; then
      echo "записал бы $PLIST ($([ "$APPLY" = 1 ] && echo 'снимает' || echo 'сухо')); launchctl bootstrap gui/$(id -u) $PLIST"
      exit 0
    fi
    mkdir -p "$AGENTS" "$LIN"
    render > "$PLIST.tmp"
    plutil -lint "$PLIST.tmp" >/dev/null
    mv "$PLIST.tmp" "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "поставлен $LABEL ($([ "$APPLY" = 1 ] && echo 'снимает' || echo 'сухо, только журнал')), раз в 30 мин; журнал $LIN/reap-auto.jsonl"
    ;;
  uninstall)
    if [ "$DRY" = 1 ]; then echo "launchctl bootout gui/$(id -u)/$LABEL; rm -f $PLIST"; exit 0; fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "снят $LABEL"
    ;;
  *)
    awk 'NR>1{if(/^#/)print;else exit}' "$0"; exit 2 ;;
esac
