#!/bin/sh
# Delivers the Mac's memory proxy token to the VPS app (OPS-19):
#   memory-token-push.sh <vps host>        e.g. memory-token-push.sh 10.77.0.1
# The token travels on ssh's stdin only: not in argv, not on stdout, not in the
# shell history. On the VPS it lands in /opt/t-boards/secrets as the app's file
# (0400, uid 1001, like the other app secrets); the app reads it on every
# request, and `up -d app` only makes sure the app runs on the current compose.
set -eu

host="${1:-}"
[ -n "$host" ] || {
  echo "usage: $0 <vps host>" >&2
  exit 2
}
token_file="${CMEM_PROXY_TOKEN_FILE:-$HOME/.t-boards-memory/proxy_token}"
[ -s "$token_file" ] || {
  echo "нет токена $token_file — сначала memory-agent.sh token" >&2
  exit 1
}

# A temporary name and mv: the app never reads a half-written file.
# shellcheck disable=SC2016 # expanded on the VPS
remote='set -eu
umask 077
f=/opt/t-boards/secrets/claude_mem_proxy_token
cat >"$f.new"
[ -s "$f.new" ] || { rm -f "$f.new"; echo "пустой токен, ничего не меняю" >&2; exit 1; }
chown 1001:1001 "$f.new"
chmod 0400 "$f.new"
mv -f "$f.new" "$f"
echo "токен на месте: $f"
cd /opt/t-boards && docker compose -p t-boards up -d app'

# shellcheck disable=SC2029 # $remote is the script text; its variables expand on the VPS
ssh "root@$host" "$remote" <"$token_file"
echo "готово. Проверка: README «Memory proxy token», приёмка"
