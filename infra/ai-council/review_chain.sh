#!/usr/bin/env bash
# Цепочка ревью PR (решение владельца 13.11): opencode → GLM → Claude. Один отчёт, коды как у glm_pr_review.py.
#
#   infra/ai-council/review_chain.sh <PR> <out.json> [lenses.json] [флаги glm_pr_review.py]
#
# 1. opencode (--backend opencode): код 0 — готово.
# 2. Иначе GLM с --resume <out.json>: прошедшие на opencode части не повторяются.
# 3. GLM не закрыл всё — непройденные части (_meta.not_passed) берёт Claude: не больше 2 агентов-линз на PR.
#
# Запуск — из основного checkout: квота и бюджет GLM живут в его .claude/council/council.db.
# REVIEW_CHAIN_FORCE=glm — начать сразу с GLM (opencode сломан или его лимит известен заранее).
# OPENCODE_REVIEW_MODEL — модель opencode (умолчание в glm_pr_review.py).
# Коды: 0 — все линзы прошли; 1 — запуск; 2 — часть не прошла; 3 — квота или бюджет GLM.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
pr="${1:?usage: review_chain.sh <PR> <out.json> [lenses.json] [флаги]}"
out="${2:?usage: review_chain.sh <PR> <out.json> [lenses.json] [флаги]}"
shift 2
lenses=()
if [[ $# -gt 0 && "$1" != --* ]]; then
  lenses=("$1")
  shift
fi

review() { # backend model [флаги]
  local backend="$1" model="$2"
  shift 2
  python3 "$here/glm_pr_review.py" "$pr" "$out" "$model" ${lenses[@]+"${lenses[@]}"} --backend "$backend" "$@"
}

if [[ "${REVIEW_CHAIN_FORCE:-}" != glm ]]; then
  review opencode "${OPENCODE_REVIEW_MODEL:-}" "$@"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    exit 0
  fi
  echo "review_chain: opencode код $rc — остаток линз уходит к GLM" >&2
fi

resume=()
if [[ -s "$out" ]]; then
  resume=(--resume "$out")
fi
review glm "" ${resume[@]+"${resume[@]}"} "$@"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "review_chain: GLM код $rc — непройденные части (_meta.not_passed в $out) берёт Claude: не больше 2 агентов-линз на PR" >&2
fi
exit "$rc"
