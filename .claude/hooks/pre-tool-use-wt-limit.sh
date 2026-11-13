#!/usr/bin/env bash
# PreToolUse (Bash): `git worktree add` сверх предела worktree продукта (OPS-52, решение владельца 13.11: не больше 10
# на продукт) — блок с подсказкой. Предел и подсчёт — eval/tools/wt_gc.py check-limit по основному checkout репозитория.
# Какие команды — фильтр `if` в .claude/settings.json; обход для одной команды — WT_LIMIT_CHECK=0 в её начале.
# Fail-open: любой сбой самого хука — exit 0.
input="$(cat)" || exit 0
[ "${WT_LIMIT_CHECK:-}" = 0 ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)" || exit 0
case "$cmd" in *WT_LIMIT_CHECK=0*) exit 0 ;; *"worktree add"*) ;; *) exit 0 ;; esac

# Ведущий `cd X &&` меняет репозиторий; относительный X — от cwd.
lead="$(printf '%s' "$cmd" | sed -nE 's/^[[:space:]]*cd[[:space:]]+("([^"]+)"|'"'"'([^'"'"']+)'"'"'|([^[:space:]&;|]+))[[:space:]]*(&&|;).*/\2\3\4/p')"
if [ -n "$lead" ]; then
  case "$lead" in
    "~"*) lead="$HOME${lead#\~}" ;;
    /*) ;;
    *) lead="${dir:-.}/$lead" ;;
  esac
  dir="$lead"
fi
[ -n "$dir" ] && [ -d "$dir" ] || exit 0
# Основной checkout: каталог общего .git (у linked worktree — .git основного).
common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
repo="$(dirname "$common")"
[ -d "$repo" ] || exit 0

script="$(dirname "$0")/../../eval/tools/wt_gc.py"
[ -f "$script" ] || exit 0
err="$(python3 -I "$script" check-limit "$repo" 2>&1 >/dev/null)"
[ $? -eq 3 ] || exit 0
{
  echo "Новый worktree не создан."
  printf '%s\n' "$err"
  echo "Владелец разрешил исключение — добавь WT_LIMIT_CHECK=0 в начало команды."
} >&2
exit 2
