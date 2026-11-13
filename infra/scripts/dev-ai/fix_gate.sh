#!/usr/bin/env bash
# Мелкая правка opencode (решение владельца 13.11): не больше 20 строк кода и 2 файлов кода; тесты не считаются.
#
#   fix_gate.sh pre  <worktree>               — рабочая копия чистая? Нет — opencode fix не запускать.
#   fix_gate.sh post <worktree> [--rollback]  — правка в лимите? Нет — код 1, с --rollback откат до HEAD.
#
# Считает и новые файлы (git add -N), без поиска переименований. Бинарный файл, lock-файлы, миграции, снапшоты,
# .claude/, .opencode/ и opencode.json — отказ: это не «мелкая правка». Откат безопасен только после «pre»:
# в чистой копии сбросить можно лишь то, что написал opencode.
# FIX_GATE_LINES / FIX_GATE_FILES — другие пределы (по умолчанию 20 и 2).
set -euo pipefail

mode="${1:?usage: fix_gate.sh pre|post <worktree> [--rollback]}"
wt="${2:?usage: fix_gate.sh pre|post <worktree> [--rollback]}"
rollback="${3:-}"
max_lines="${FIX_GATE_LINES:-20}"
max_files="${FIX_GATE_FILES:-2}"
test_re='(^|/)(__tests__|tests?|e2e)/|\.(spec|test)\.[cm]?[jt]sx?$|(^|/)(test_[^/]*|[^/]*_test)\.py$'
deny_re='(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock)$|(^|/)drizzle/|(^|/)migrations/|\.snap$|^\.claude/|^\.opencode/|^opencode\.jsonc?$'

g() { git -C "$wt" "$@"; }

case "$mode" in
  pre)
    if [[ -n "$(g status --porcelain)" ]]; then
      echo "fix_gate: рабочая копия не чистая — закоммитьте своё до opencode fix" >&2
      exit 1
    fi
    echo "fix_gate: чисто"
    exit 0
    ;;
  post) ;;
  *)
    echo "usage: fix_gate.sh pre|post <worktree> [--rollback]" >&2
    exit 2
    ;;
esac

g add -N -- . >/dev/null
reason="" lines=0 files=0 tests=0
while IFS=$'\t' read -r add del path; do
  [[ -n "$path" ]] || continue
  if [[ "$add" == "-" ]]; then
    reason="бинарный файл $path"
    break
  fi
  if [[ "$path" =~ $deny_re ]]; then
    reason="путь не для мелкой правки: $path"
    break
  fi
  if [[ "$path" =~ $test_re ]]; then
    tests=$((tests + 1))
    continue
  fi
  files=$((files + 1))
  lines=$((lines + add + del))
done < <(g diff --numstat --no-renames HEAD)

if [[ -z "$reason" && $files -gt $max_files ]]; then reason="файлов кода $files > $max_files"; fi
if [[ -z "$reason" && $lines -gt $max_lines ]]; then reason="строк кода $lines > $max_lines"; fi
if [[ -z "$reason" && $files -eq 0 && $tests -eq 0 ]]; then reason="правки нет"; fi

if [[ -n "$reason" ]]; then
  echo "fix_gate: не мелкая правка — $reason; правку делает Claude" >&2
  if [[ "$rollback" == --rollback ]]; then
    g reset -q --hard HEAD
    g clean -fdq
    echo "fix_gate: откат до HEAD" >&2
  fi
  exit 1
fi
echo "fix_gate: ок — строк кода $lines, файлов кода $files, файлов тестов $tests"
