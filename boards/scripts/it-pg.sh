#!/usr/bin/env bash
# TB-145: API integration tests on a throwaway Postgres of their own.
#
#   scripts/it-pg.sh <name> [vitest args…]        (from boards/)
#   scripts/it-pg.sh tb145 tests/api-integration/health.test.ts
#
# <name> is the worktree or the card (a-z, 0-9, ., _, -); the container is
# <name>-it-pg. IT_PG_PORT fixes the port; otherwise the first free port in
# 55400-55499 is used. Build the workspace packages first:
#   pnpm -r --filter "@kaneo/api^..." build
#
# The container is removed on every exit: green, red, error, Ctrl-C. The
# cleanup removes only the container with this run's label, so it never
# touches another session's database or the live ones: t-boards-postgres-1
# (5433) and backend-postgres-1 (5432).
set -euo pipefail

fail() {
  echo "it-pg: $2" >&2
  exit "$1"
}

[ $# -ge 1 ] || fail 2 "usage: scripts/it-pg.sh <name> [vitest args…]"
base="$1"
shift
[[ "$base" =~ ^[a-z0-9][a-z0-9_.-]{0,40}$ ]] ||
  fail 2 "name «${base}»: use a-z, 0-9, «.», «_», «-», up to 41 characters"
# Ends in -it-pg: never the name of a live container.
name="${base}-it-pg"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ -n "${IT_PG_PORT:-}" ]; then
  port="$IT_PG_PORT"
  [[ "$port" =~ ^[0-9]{4,5}$ ]] || fail 2 "IT_PG_PORT «${port}» is not a port"
  case "$port" in
  5432 | 5433) fail 2 "port $port belongs to a live database" ;;
  esac
  if listening "$port"; then fail 3 "port $port is taken"; fi
else
  port=""
  for candidate in $(seq 55400 55499); do
    if ! listening "$candidate"; then
      port="$candidate"
      break
    fi
  done
  [ -n "$port" ] || fail 3 "no free port in 55400-55499"
fi

if [ -n "$(docker ps -aq --filter "name=^/${name}$")" ]; then
  fail 3 "container $name already exists: another run of «${base}» is active, or a run left it (check it, then docker rm -f $name)"
fi

# od reads a fixed number of bytes: no SIGPIPE under pipefail.
run_id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"

cleanup() {
  local id
  id="$(docker ps -aq --filter "label=it-pg.run=${run_id}" 2>/dev/null || true)"
  if [ -n "$id" ]; then docker rm -f "$id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container="$(docker run -d --rm --name "$name" --label "it-pg.run=${run_id}" \
  -e POSTGRES_USER=kaneo -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=kaneo_test \
  -p "127.0.0.1:${port}:5432" postgres:16)"

# The tests run only against the port of this container.
mapped="$(docker port "$container" 5432)"
[ "${mapped%%$'\n'*}" = "127.0.0.1:${port}" ] ||
  fail 3 "$name publishes 5432 on «${mapped}», not 127.0.0.1:${port}"

ready=""
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U kaneo -d kaneo_test >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail 3 "Postgres in $name is not ready after 60 s"

echo "it-pg: $name on 127.0.0.1:${port}" >&2
cd "$(dirname "${BASH_SOURCE[0]}")/../apps/api"
DATABASE_URL="postgresql://kaneo:${password}@127.0.0.1:${port}/kaneo_test" \
  npx vp test run --config vitest.integration.config.ts "$@"
