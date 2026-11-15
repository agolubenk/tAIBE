#!/usr/bin/env bash
# Агенты opencode слоя (taibe-review — линза ревью без инструментов, taibe-fix — мелкая правка) — ссылками в
# ~/.config/opencode/agents/. Один источник для tAIBE и HR_Helper-v2: ревью запускается во временной папке, а правка —
# в worktree любого из репозиториев, поэтому агенты глобальные, а не проектные.
#
#   bash infra/opencode/install.sh            # из основного checkout tAIBE, после мёржа
#   bash infra/opencode/install.sh --check    # ссылки на месте и ведут в основной checkout? код 1 — нет
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
root="${common%/.git}"
src="$root/infra/opencode/agents"
dst="${OPENCODE_AGENTS_DIR:-$HOME/.config/opencode/agents}"

if [[ ! -d "$src" ]]; then
  echo "нет $src — агенты ещё не влиты в основной checkout; ставить после мёржа" >&2
  exit 1
fi

status=0
for f in "$src"/*.md; do
  link="$dst/$(basename "$f")"
  if [[ "${1:-}" == --check ]]; then
    if [[ "$(readlink "$link" 2>/dev/null)" != "$f" ]]; then
      echo "нет ссылки: $link → $f" >&2
      status=1
    fi
    continue
  fi
  mkdir -p "$dst"
  ln -sfn "$f" "$link"
  echo "→ $link"
done

if ! command -v opencode >/dev/null; then
  echo "opencode не установлен — пункт владельца s-opencode-1311 (brew install anomalyco/tap/opencode-v2)" >&2
fi
exit "$status"
