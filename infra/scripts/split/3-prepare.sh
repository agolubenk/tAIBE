#!/bin/bash
# Шаг 3. Подготовить checkout tAIBE, пока сервисы работают из HR: проверки слоя и eval, зависимости досок и пакет
# MCP, файлы окружения досок, перенос неотправленных коммитов вложенных репозиториев в ветки rescue/*.
export STEP=3
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"
cd "$TB" || stop "нет $TB"

"$PY" -I eval/pipeline/genome/build.py --check >"$BK/state/genome-check.txt" 2>&1 ||
  stop "геномы tAIBE не сходятся с конфигом: $(tail -3 "$BK/state/genome-check.txt" | tr '\n' ' ')"
ok "геномы ролей сходятся с eval/nerve/config.json"

fails=""
for t in .claude/hooks/test_*.py .claude/scripts/test_*.py; do
  "$PY" "$t" >/dev/null 2>&1 || fails="$fails $t"
done
for d in eval/nerve eval/pipeline; do
  "$PY" -I -m unittest discover -s "$d" -p 'test_*.py' >"$BK/state/unittest-$(basename "$d").txt" 2>&1 || fails="$fails $d"
done
[ -z "$fails" ] || stop "в tAIBE не прошли тесты:$fails"
ok "тесты хуков, скриптов слоя, Нерва и пайплайна зелёные"

if "$PY" -I .claude/scripts/pipeline_settings.py enabled nerveWakes >/dev/null 2>&1; then
  ok "nerveWakes включено: Нерв будет будить сессии"
elif [ "${SPLIT_OWNER_OK_WAKES:-0}" != 1 ]; then
  stop "в настройках пайплайна продукта nerveWakes выключено — после переезда Нерв никого не будит. Владелец: включить на доске или подтвердить. Продолжить: SPLIT_OWNER_OK_WAKES=1 bash $0"
fi

if [ "${SPLIT_SKIP_DEPS:-0}" = 1 ]; then
  warn "SPLIT_SKIP_DEPS=1 — зависимости досок не ставятся (только для проверки скриптов)"
else
  # pnpm 10.x: через corepack, если он есть (с Node 25 его нет в поставке), иначе свой pnpm 10.x, иначе npx.
  PNPM=""
  if has corepack && (cd boards && corepack pnpm --version >/dev/null 2>&1); then
    PNPM="corepack pnpm"
  elif has pnpm && pnpm --version 2>/dev/null | grep -q '^10\.'; then
    PNPM="pnpm"
  elif has npx; then
    PNPM="npx -y pnpm@10.32.1"
  fi
  [ -n "$PNPM" ] || stop "нет pnpm 10.x: ни corepack, ни pnpm 10, ни npx"
  log "pnpm: $PNPM ($(cd boards && $PNPM --version 2>/dev/null))"
  (cd boards && $PNPM install --frozen-lockfile >"$BK/state/pnpm-install.txt" 2>&1) ||
    stop "pnpm install в boards/ не прошёл: $(tail -3 "$BK/state/pnpm-install.txt" | tr '\n' ' ')"
  (cd boards && $PNPM --filter "./packages/*" build >"$BK/state/pnpm-build.txt" 2>&1) ||
    stop "сборка пакетов досок не прошла: $(tail -3 "$BK/state/pnpm-build.txt" | tr '\n' ' ')"
  [ -f boards/packages/mcp/dist/index.js ] || stop "после сборки нет boards/packages/mcp/dist/index.js"
  ok "зависимости досок стоят, пакет MCP собран"
fi

for f in .env .env.local apps/web/.env.local; do
  if [ -f "$HR/t-boards/app/$f" ] && [ ! -e "$TB/boards/$f" ]; then
    cp -p "$HR/t-boards/app/$f" "$TB/boards/$f" && log "файл окружения досок скопирован: boards/$f"
  fi
done

bash "$SPLIT_DIR/port-all.sh"
rc=$?
[ "$rc" = 2 ] && stop "нет снимка вложенных репозиториев — сначала шаг 2"
if [ "$rc" = 5 ]; then
  if [ "${SPLIT_OWNER_OK_PORT:-0}" = 1 ]; then
    warn "часть коммитов не применилась в tAIBE — по решению владельца идём дальше: они целы в бандлах снимка и в $BK/patches"
    rc=0
  else
    stop "часть коммитов не применилась в tAIBE (строки «НЕ ПРИМЕНИЛСЯ» в $BK/port-report.txt) — они целы в бандлах снимка и в $BK/patches; разбор — потом, решение владельца. Продолжить: SPLIT_OWNER_OK_PORT=1 bash $0"
  fi
fi
[ "$rc" = 0 ] || stop "перенос коммитов не прошёл (код $rc), см. $BK/port-report.txt"
ok "неотправленные коммиты: отчёт $BK/port-report.txt"
next "bash $SPLIT_DIR/4-hr-pr.sh"
