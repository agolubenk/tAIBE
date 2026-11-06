#!/usr/bin/env bash
# Перезапуск всего локального ИИ-контура одной командой: MCP-хаб (serena + 1mcp) и AI Council.
# Кнопка «⟳ ИИ: всё» в строке состояния VS Code (задача в .vscode/tasks.json, расширение
# actboy168.tasks) зовёт именно это.
#
#   bash infra/scripts/dev-ai/ai-restart-all.sh            # перезапуск + сводный статус + перепроверка
#   bash infra/scripts/dev-ai/ai-restart-all.sh status     # только статус
#   npm run ai:restart-all | npm run ai:status-all
#
# Код возврата перезапуска — 1, если хаб или консилиум не поднялись или если после всего
# serena/хаб не живы, не держат свои порты или не отвечают (mcp-hub.sh check). Перезапуск — только
# из основной папки репо: из связанного worktree — отказ до того, как что-то остановлено.
#
# Ollama и Docker-стек не трогаются: Ollama — общий демон (нужен и продуктовому dev:ai),
# Docker — продуктовый стек, его рестарт рвёт сессии разработки.
#
# Консилиум останавливается мягко: воркер доделывает текущий прогон и выходит, новый
# подхватывает очередь с того же места (queue_control.recover_orphans). Пауза очереди
# (Обзор → «Управление очередью») рестартом не снимается — это решение владельца; статус
# показывает, кто, когда и зачем её поставил: со стороны пауза выглядит как «консилиум не работает».
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"

# python3 из CommandLineTools (без пакета mcp) не должен перекрыть основной — тот же
# капкан, что описан в CLAUDE.local.md: CLT-префикс PATH только для git.
PY="$(command -v python3)"
case "$PY" in /Library/Developer/CommandLineTools/*) PY="/usr/local/bin/python3";; esac

COUNCIL_DB="${TAIBE_HOST_ROOT:-$ROOT}/.claude/council/council.db"  # база — у хоста (TAIBE_HOST_ROOT), код — в слое

status() {
  echo "── MCP-хаб ─────────────────────────────────────────"
  bash "$SCRIPT_DIR/mcp-hub.sh" status 2>&1 | sed 's/^/  /'
  echo "── AI Council ──────────────────────────────────────"
  if [ ! -f "$COUNCIL_DB" ]; then
    # Иначе supervisor.py status создал бы здесь пустую базу и показал «всё остановлено»,
    # хотя консилиум работает из основной папки репо (так бывает при запуске из worktree).
    echo "  в этой копии репо консилиум не запускался (нет .claude/council/council.db) — статус смотреть из основной папки"
    return 0
  fi
  "$PY" infra/ai-council/supervisor.py status 2>&1 | sed -n '1,9p' | sed 's/^/  /'
  "$PY" - <<'EOF' 2>&1 | sed 's/^/  /'
import sys, time
sys.path.insert(0, "infra/ai-council")


def when(ts):
    try:
        return time.strftime("%d.%m %H:%M", time.localtime(int(ts)))
    except (TypeError, ValueError):
        return "?"


try:
    from store import Store
    import queue_control
    with Store() as s:
        st = queue_control.status(s)
except Exception as exc:  # noqa: BLE001 — статус не должен падать трассой
    print(f"очередь: не прочитать — {exc} (python3 infra/ai-council/queue_control.py status)")
    raise SystemExit(0)
paused = st["paused"]
print("очередь:", "ПАУЗА" if paused else "идёт",
      "· queued", st["runs"].get("queued", 0), "· running", st["runs"].get("running", 0),
      "· ревью queued", st["review"].get("queued", 0))
if paused:
    p = paused if isinstance(paused, dict) else {}
    print(f"  пауза с {when(p.get('at'))} · кто: {p.get('by') or '?'} · причина: {p.get('reason') or 'не указана'}")
    print("  снять: UI консилиума → Обзор → «Управление очередью» → «Продолжить с того же места»"
          " (или python3 infra/ai-council/queue_control.py resume)")
for k, v in (st["memory_blocked"] or {}).items():
    why = f" — {v['why']}" if v.get("why") else ""
    print(f"  ждёт память: {v.get('label') or k}{why} (с {when(v.get('since'))})")
EOF
}

if [ "${1:-restart}" = "status" ]; then
  status
  exit 0
fi

# Общий контур перезапускается только из основной папки репо (как mcp-hub.sh start/restart): из
# worktree хаб откажет, а консилиум поднялся бы из копии worktree — контур остался бы перезапущен наполовину.
if [ -f "$ROOT/.git" ] && [ "${MCP_HUB_ALLOW_WORKTREE:-}" != 1 ]; then
  MAIN="$(sed -n 's|^gitdir: \(.*\)/\.git/worktrees/.*|\1|p' "$ROOT/.git" 2>/dev/null)"
  if [ -n "$MAIN" ]; then
    echo "✗ ИИ-контур перезапускается из основной папки репо: (cd $MAIN && npm run ai:restart-all)" >&2
    exit 1
  fi
fi

failed=0
echo "▶ MCP-хаб: serena + 1mcp"
bash "$SCRIPT_DIR/mcp-hub.sh" restart || { echo "✗ MCP-хаб поднялся не весь — npm run mcp-hub:logs"; failed=1; }
echo
echo "▶ AI Council: супервизор и сервисы"
"$PY" infra/ai-council/supervisor.py restart || { echo "✗ консилиум не поднялся — .claude/council/supervisor.log"; failed=1; }
echo
status
echo
# Финальная перепроверка: к этому моменту хаб и serena должны быть живы, держать свои порты и
# отвечать. Иначе — ненулевой код, чтобы задача VS Code и npm показали сбой, а не «готово».
echo "▶ Перепроверка хаба и serena"
if bash "$SCRIPT_DIR/mcp-hub.sh" check; then
  echo "✓ хаб и serena живы и отвечают"
else
  echo "✗ хаб или serena не работают после перезапуска — npm run mcp-hub:status, логи: npm run mcp-hub:logs"
  failed=1
fi
exit $failed
