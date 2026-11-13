#!/usr/bin/env bash
# Тест предела мелкой правки opencode (infra/scripts/dev-ai/fix_gate.sh, решение владельца 13.11).
#
#   bash infra/scripts/dev-ai/tests/fix-gate.test.sh      # ~1 с, сети нет
#
# Проверяет: pre — грязная копия отказ; post — 20 строк в 1 файле ок, 21 строка отказ, 3 файла кода отказ,
# новый файл считается (git add -N), тест не считается, бинарный файл, lock-файл и пути поставки отказ, нет правки отказ,
# --rollback возвращает копию к HEAD и убирает новые файлы.
set -euo pipefail

gate="$(cd "$(dirname "$0")/.." && pwd)/fix_gate.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

repo() {
  rm -rf "$tmp/r"
  git init -q "$tmp/r"
  git -C "$tmp/r" config user.email t@t && git -C "$tmp/r" config user.name t
  printf 'a\n' >"$tmp/r/a.py"
  git -C "$tmp/r" add . && git -C "$tmp/r" commit -qm init
}

expect() { # name code cmd...
  local name="$1" want="$2"
  shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name — код $got, ждали $want"
    fails=$((fails + 1))
  fi
}

lines() { # file n
  local i
  for ((i = 0; i < $2; i++)); do echo "x$i"; done >>"$tmp/r/$1"
}

repo
expect "pre: чистая копия" 0 bash "$gate" pre "$tmp/r"
lines a.py 1
expect "pre: грязная копия — отказ" 1 bash "$gate" pre "$tmp/r"

repo; lines a.py 20
expect "post: 20 строк в одном файле — ок" 0 bash "$gate" post "$tmp/r"
repo; lines a.py 21
expect "post: 21 строка — отказ" 1 bash "$gate" post "$tmp/r"
repo; lines a.py 1; lines b.py 1; lines c.py 1
expect "post: 3 файла кода — отказ" 1 bash "$gate" post "$tmp/r"
repo; lines new.py 25
expect "post: новый файл на 25 строк считается — отказ" 1 bash "$gate" post "$tmp/r"
repo; lines a.py 5; mkdir -p "$tmp/r/tests"; lines tests/test_a.py 80
expect "post: тест на 80 строк не считается — ок" 0 bash "$gate" post "$tmp/r"
repo; printf '\x00\x01' >"$tmp/r/blob.bin"
expect "post: бинарный файл — отказ" 1 bash "$gate" post "$tmp/r"
repo; lines package-lock.json 1
expect "post: lock-файл — отказ" 1 bash "$gate" post "$tmp/r"
repo
expect "post: правки нет — отказ" 1 bash "$gate" post "$tmp/r"
repo; mkdir -p "$tmp/r/.github/workflows"; lines .github/workflows/ci.yml 2
expect "post: workflow .github/ — отказ" 1 bash "$gate" post "$tmp/r"
repo; mkdir -p "$tmp/r/boards/deploy/vps"; lines boards/deploy/vps/run.sh 2
expect "post: путь deploy/ — отказ" 1 bash "$gate" post "$tmp/r"
repo; mkdir -p "$tmp/r/infra/scripts/prod"; lines infra/scripts/prod/x.sh 2
expect "post: infra/scripts/prod — отказ" 1 bash "$gate" post "$tmp/r"
repo; lines Dockerfile.api 1
expect "post: Dockerfile — отказ" 1 bash "$gate" post "$tmp/r"

repo; lines a.py 30; lines extra.py 3
expect "post --rollback: отказ" 1 bash "$gate" post "$tmp/r" --rollback
if [[ -z "$(git -C "$tmp/r" status --porcelain)" ]]; then
  echo "  ✓ post --rollback: копия у HEAD, новых файлов нет"
else
  echo "  ✗ post --rollback: копия не чистая"
  fails=$((fails + 1))
fi

if [[ $fails -gt 0 ]]; then
  echo "fix-gate: провалов $fails"
  exit 1
fi
echo "fix-gate: все проверки пройдены"
