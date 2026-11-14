#!/bin/sh
# AC-004: restores a dump into a throwaway Postgres 16 and prints what came
# back. Nothing touches the dev database; the container and its data are
# removed afterwards. Usage: restore-check.sh [dump]  (default: newest pulled)
set -eu

dump="${1:-$(ls -t "$HOME"/t-boards-backups/t-boards-*.dump 2>/dev/null | head -1 || true)}"
[ -n "$dump" ] && [ -s "$dump" ] || {
  echo "нет дампа" >&2
  exit 1
}
name="tb-restore-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -e POSTGRES_PASSWORD=restore-check -e POSTGRES_DB=t_boards \
  -e POSTGRES_USER=t_boards postgres:16-alpine >/dev/null
i=0
until docker exec "$name" pg_isready -U t_boards -d t_boards >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || {
    echo "postgres не поднялся" >&2
    exit 1
  }
  sleep 1
done
# The server may report ready before the init scripts finish; wait them out.
sleep 3
# Roles are cluster-wide and a dump does not carry them. Since migration 0084
# (TB-28, owner-queue schema) a dump grants to oq_console, so the roles come
# first, as in that migration; the production restore does the same.
docker exec "$name" psql -U t_boards -d t_boards -v ON_ERROR_STOP=1 -q -c "
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oq_owner') THEN CREATE ROLE oq_owner NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'oq_console') THEN CREATE ROLE oq_console NOLOGIN; END IF;
  END \$\$"
docker exec -i "$name" pg_restore --no-owner -U t_boards -d t_boards <"$dump"
# write guards: 3 owner-queue triggers came back (0 for a dump older than 0084).
docker exec "$name" psql -U t_boards -d t_boards -At -F ' ' -c "
  select 'migrations', count(*) from drizzle.__drizzle_migrations
  union all select 'users', count(*) from \"user\"
  union all select 'workspaces', count(*) from workspace
  union all select 'projects', count(*) from project
  union all select 'tasks', count(*) from task
  union all select 'oq_guards', count(*) from pg_trigger where tgname like 'oq\\_%\\_writer'"
echo "restore ok: $(basename "$dump")"
