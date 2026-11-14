#!/usr/bin/env bash
# PreToolUse (Bash): гейт в linked worktree без своих зависимостей — блок с командой починки.
# Без своего node_modules Node берёт node_modules основного checkout, и typecheck/test/lint
# дают ложные ошибки («EXTENSION_AUTH_CODES is not iterable», ретро 30.10). В основном checkout
# и вне worktree — молчит. Какие команды — фильтр `if` в .claude/settings.json; обход —
# WT_DEPS_CHECK=0 в самой команде; выключить для всей сессии — WT_DEPS_CHECK=0 в окружении claude.
# Fail-open: любой сбой самого хука — exit 0.
input="$(cat)" || exit 0
[ "${WT_DEPS_CHECK:-}" = 0 ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
dir="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)" || exit 0
[ -n "$cmd" ] || exit 0
case "$cmd" in *WT_DEPS_CHECK=0*) exit 0 ;; esac
# Установка зависимостей — это сама починка, её не останавливаем (SE-124): иначе после правки lockfile хук держит и
# гейт, и свою команду починки. Слово `install`/`i`/`ci` — подкоманда pnpm|npm (флаги вроде -C X, --dir X допустимы).
if printf '%s' "$cmd" | grep -qE '(^|[;&|(][[:space:]]*|[[:space:]])(pnpm|npm)([[:space:]]+(-C|--dir|--prefix)([[:space:]]+|=)[^[:space:]]+)*([[:space:]]+-[-A-Za-z]+)*[[:space:]]+(install|i|ci)([[:space:]]|$)'; then
  exit 0
fi

# Ведущий `cd X &&` меняет каталог гейта; относительный X — от cwd.
lead="$(printf '%s' "$cmd" | sed -nE 's/^[[:space:]]*cd[[:space:]]+("([^"]+)"|'"'"'([^'"'"']+)'"'"'|([^[:space:]&;|]+))[[:space:]]*(&&|;).*/\2\3\4/p')"
if [ -n "$lead" ]; then
  case "$lead" in
    "~"*) lead="$HOME${lead#\~}" ;;
    /*) ;;
    *) lead="${dir:-.}/$lead" ;;
  esac
  dir="$lead"
fi
# `pnpm -C X …` / `pnpm --dir X …` (или `=X`) меняет каталог гейта так же, как ведущий `cd`.
pdir="$(printf '%s' "$cmd" | sed -nE 's/.*pnpm([[:space:]]+[^[:space:]]+)*[[:space:]]+(-C|--dir)(=|[[:space:]]+)("([^"]+)"|([^[:space:]&;|]+)).*/\5\6/p')"
if [ -n "$pdir" ]; then
  case "$pdir" in
    "~"*) pdir="$HOME${pdir#\~}" ;;
    /*) ;;
    *) pdir="${dir:-.}/$pdir" ;;
  esac
  dir="$pdir"
fi
# `make check-boards` гоняет гейты досок.
case "$cmd" in *"make check-boards"*) [ -d "${dir:-.}/boards" ] && dir="${dir:-.}/boards" ;; esac
[ -n "$dir" ] && [ -d "$dir" ] || exit 0

script="$(dirname "$0")/../../infra/scripts/dev/wt-deps.sh"
[ -f "$script" ] || exit 0
err="$(bash "$script" check "$dir" 2>&1 >/dev/null)"
[ $? -eq 1 ] || exit 0
{
  echo "Гейт остановлен: зависимости worktree не свои или устарели — результат был бы ложным."
  printf '%s\n' "$err"
  echo "Команда не про зависимости — добавь WT_DEPS_CHECK=0 в её начало."
} >&2
exit 2
