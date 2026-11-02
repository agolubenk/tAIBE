#!/bin/bash
# Все неотправленные ветки последнего снимка (scan.sh) — в ветки rescue/* tAIBE; непустые отправить, пустые удалить.
# Отчёт — $BK/port-report.txt. Не мёржит.
export STEP="${STEP:-port}"
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

S="$(last_scan)"
[ -n "$S" ] && [ -f "$S/unpushed.txt" ] || {
  echo "нет снимка: сначала scan.sh"
  exit 2
}
report="$BK/port-report.txt"
run="$BK/port-last.txt" # только этот прогон: решение «СТОП» — по нему, а не по всему отчёту
{
  echo "--- $(date '+%Y-%m-%d %H:%M:%S'), снимок $S"
  while read -r repo branch _n; do
    [ -n "$repo" ] || continue
    bash "$SPLIT_DIR/port.sh" "$repo" "$branch"
  done <"$S/unpushed.txt"
} >"$run"
tee -a "$report" <"$run"

for rb in $(git -C "$TB" for-each-ref --format='%(refname:short)' 'refs/heads/rescue/*'); do
  n="$(git -C "$TB" rev-list --count "origin/board-agents..$rb")"
  if [ "$n" = 0 ]; then
    git -C "$TB" branch -q -D "$rb" && echo "пустая ветка удалена: $rb" | tee -a "$report" "$run"
  else
    git -C "$TB" push -q -u origin "$rb" && echo "отправлена: $rb ($n коммитов, не мёржить)" | tee -a "$report" "$run"
  fi
done
grep -q 'НЕ ПРИМЕНИЛСЯ' "$run" && exit 5
exit 0
