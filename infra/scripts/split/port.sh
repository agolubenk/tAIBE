#!/bin/bash
# port.sh <repo> <branch>: коммиты ветки вложенного репозитория, которых нет в tAIBE, — по порядку (сначала старые)
# в ветку rescue/<repo>-<branch> checkout'а tAIBE. Код форка в t-boards/app лежит от корня, в tAIBE — под boards/.
# Повторный запуск дописывает только новые коммиты. Ветку не отправляет (это делает port-all.sh) и не мёржит.
export STEP="${STEP:-port}"
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

r="${1:?repo}"
b="${2:?branch}"
name="rescue/$(basename "$r")-$(printf '%s' "$b" | tr '/' '-')"
amdir="--directory=boards"
[ -d "$r/boards" ] && amdir="" # клон самого tAIBE: пути уже под boards/

todo=""
for s in $(git -C "$r" rev-list --reverse --topo-order "$b" --not --remotes); do
  git -C "$TB" cat-file -e "$s^{commit}" 2>/dev/null || todo="$todo $s"
done
if [ -z "$todo" ]; then
  echo "$r $b: всё уже есть в tAIBE"
  exit 0
fi

git -C "$TB" fetch -q origin || exit 2
if git -C "$TB" rev-parse -q --verify "refs/heads/$name" >/dev/null; then
  git -C "$TB" switch -q "$name" || exit 2
else
  git -C "$TB" switch -q -c "$name" origin/board-agents || exit 2
fi
for s in $todo; do
  short="$(printf '%s' "$s" | cut -c1-7)"
  subj="$(git -C "$r" log -1 --format=%s "$s")"
  key="$(git -C "$r" log -1 --format='%ae %at %s' "$s")"
  if git -C "$TB" log HEAD --since=2026-10-01 --format='%ae %at %s' | grep -qxF -- "$key"; then
    echo "уже есть (тема совпала): $short $subj"
    continue
  fi
  git -C "$r" format-patch -1 "$s" --stdout >"$BK/patches/$short.patch"
  # shellcheck disable=SC2086  # пустой $amdir — без аргумента (bash 3.2: пустой массив под set -u — ошибка)
  if ! git -C "$TB" am -q --3way $amdir "$BK/patches/$short.patch"; then
    git -C "$TB" am --abort
    echo "НЕ ПРИМЕНИЛСЯ, остальное из этой ветки не переносится: $short $subj"
    break
  fi
  echo "перенесён: $short $subj"
done
git -C "$TB" switch -q board-agents
