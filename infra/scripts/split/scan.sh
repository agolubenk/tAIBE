#!/bin/bash
# Снимок всех git-репозиториев и worktree внутри переезжающих папок HR: бандл со всеми ветками, статус, правки,
# неотслеживаемые файлы, тайники; плюс правки самого HR в supertick-eval/ и t-boards/. Ничего не меняет.
# Печатает в stdout одну строку — папку снимка; её же пишет в $BK/last-scan.
export STEP="${STEP:-scan}"
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

out="$BK/scan-$(date +%H%M%S)"
mkdir -p "$out"
: > "$out/unpushed.txt"
find "$HR/t-boards" "$HR/supertick-eval" "$HR/tAIBoard_and_Eval" -maxdepth 6 \
  \( -name node_modules -o -name .pnpm-store \) -prune -o -name .git -print 2>/dev/null | while read -r g; do
  r="$(dirname "$g")"
  n="$(printf '%s' "${r#"$HR"/}" | tr '/' '_')"
  echo "=== $r" >>"$out/summary.txt"
  git -C "$r" status --porcelain >"$out/$n.status.txt" 2>&1
  git -C "$r" diff HEAD >"$out/$n.uncommitted.patch" 2>/dev/null
  git -C "$r" ls-files --others --exclude-standard -z 2>/dev/null |
    tar -C "$r" --null -T - -czf "$out/$n.untracked.tgz" 2>/dev/null || true
  if [ -d "$g" ]; then # основной репозиторий; у worktree .git — файл, его ветки и тайники — в основном
    git -C "$r" fetch --all --prune >/dev/null 2>&1 || echo "fetch не прошёл (нет сети или удалённого): $r" >>"$out/summary.txt"
    git -C "$r" stash list >"$out/$n.stash.txt" 2>/dev/null
    git -C "$r" worktree list >>"$out/summary.txt" 2>/dev/null
    if git -C "$r" bundle create "$out/$n.bundle" --all >/dev/null 2>&1 &&
      git -C "$r" bundle verify "$out/$n.bundle" >/dev/null 2>&1; then
      echo "бандл ok: $n" >>"$out/summary.txt"
    else
      echo "БАНДЛ НЕ СОЗДАН: $n" >>"$out/summary.txt"
    fi
    for b in $(git -C "$r" for-each-ref --format='%(refname:short)' refs/heads); do
      c="$(git -C "$r" rev-list --count "$b" --not --remotes 2>/dev/null || echo 0)"
      [ "$c" -gt 0 ] && echo "$r $b $c" >>"$out/unpushed.txt"
    done
  fi
  echo "правок: $(wc -l <"$out/$n.status.txt" | tr -d ' ')" >>"$out/summary.txt"
done

# 799fae6 (ветка fix/tb-notion-5xx-retry) — единственная копия на этой машине: должна оказаться в бандле.
found=0
for b in "$out"/*.bundle; do
  [ -e "$b" ] || continue
  git bundle list-heads "$b" 2>/dev/null | grep -q '^799fae6' && found=1
done
if [ "$found" = 1 ]; then echo "799fae6 в бандле: ok" >>"$out/summary.txt"; else
  echo "НЕТ 799fae6 ни в одном бандле" >>"$out/summary.txt"; fi

git -C "$HR" -c core.quotepath=off status --porcelain -- supertick-eval t-boards >"$out/hr-dirs.status.txt" 2>&1
git -C "$HR" diff -- supertick-eval t-boards >"$out/hr-dirs.uncommitted.patch" 2>/dev/null
git -C "$HR" -c core.quotepath=off ls-files -z --others --exclude-standard -- supertick-eval >"$out/hr-supertick.untracked.z" 2>/dev/null
echo "$out" >"$BK/last-scan"
echo "$out"
