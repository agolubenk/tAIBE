#!/usr/bin/env bash
# Тест .claude/hooks/pre-tool-use-wt-deps.sh. Запуск: bash .claude/hooks/test_wt_deps_hook.sh — секунда, без сети.
# Проверка зависимостей подменена заглушкой, которая всегда отвечает «не свои» (код 1): хук должен остановить гейт
# и пропустить установку зависимостей — саму починку (SE-124).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.claude/hooks" "$tmp/infra/scripts/dev" "$tmp/wt/boards"
cp "$here/pre-tool-use-wt-deps.sh" "$tmp/.claude/hooks/"
printf '#!/usr/bin/env bash\necho "lockfile newer than install" >&2\nexit 1\n' >"$tmp/infra/scripts/dev/wt-deps.sh"
hook="$tmp/.claude/hooks/pre-tool-use-wt-deps.sh"
fail=0
run() { # <команда> — код хука для Bash-вызова из каталога wt
  jq -n --arg c "$1" --arg d "$tmp/wt" '{tool_input: {command: $c}, cwd: $d}' | env -u WT_DEPS_CHECK bash "$hook" 2>/dev/null
}
expect() { # <код> <команда>
  run "$2"
  local rc=$?
  if [ "$rc" -eq "$1" ]; then echo "ok - $1: $2"; else echo "not ok - ждали $1, получили $rc: $2"; fail=1; fi
}

# Гейты — стоп.
expect 2 "pnpm typecheck"
expect 2 "pnpm -C boards test"
expect 2 "npm run typecheck"
expect 2 "npx tsc --noEmit"
expect 2 "pnpm --dir boards run build"
# Установка — проходит, в том числе с каталогом и флагами.
expect 0 "pnpm install --frozen-lockfile"
expect 0 "pnpm -C boards install --frozen-lockfile"
expect 0 "pnpm --dir=boards install"
expect 0 "pnpm i"
expect 0 "npm ci"
expect 0 "npm --prefix boards ci"
expect 0 "cd boards && pnpm install --frozen-lockfile"
# Слово install не подкомандой — гейт остаётся гейтом.
expect 2 "pnpm run install-check"
expect 2 "pnpm test -- --grep install"
# Прежний обход работает.
expect 0 "WT_DEPS_CHECK=0 pnpm typecheck"

exit "$fail"
