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
# Обход — только в начале команды (`WT_LIMIT_CHECK=0 git …` или `env WT_LIMIT_CHECK=0 …`): текст обхода в echo,
# комментарии или сообщении коммита не считается (ревью #178).
printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(env[[:space:]]+)?WT_LIMIT_CHECK=0[[:space:]]' && exit 0
printf '%s' "$cmd" | grep -Eq 'worktree[[:space:]]+add([[:space:]]|$)' || exit 0

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
# `git -C X worktree add` — репозиторий X (относительный — от каталога выше).
gdir="$(printf '%s' "$cmd" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+("([^"]+)"|'"'"'([^'"'"']+)'"'"'|([^[:space:]&;|]+))[[:space:]]+worktree[[:space:]]+add.*/\2\3\4/p')"
if [ -n "$gdir" ]; then
  case "$gdir" in
    "~"*) gdir="$HOME${gdir#\~}" ;;
    /*) ;;
    *) gdir="${dir:-.}/$gdir" ;;
  esac
  dir="$gdir"
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
  echo "Обход (WT_LIMIT_CHECK=0 в начале команды) — только если владелец разрешил это исключение в этой сессии."
} >&2
exit 2
