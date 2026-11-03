#!/usr/bin/env bash
# Turns the Notion mirror on (AC-002, AC-003): stores the token as a file,
# checks it can read every database, writes the workspace and the databases
# into /opt/t-boards/.env and recreates the app. Run after install.sh: it
# seeds the HR Helper product the mirror writes into.
# Usage: mirror-setup.sh [DATABASE_ID,…,all [WORKSPACE_ID]]  (asks for the token)
# "all" also mirrors every other database shared with the integration; the
# owner disabled discovery 04.11: with "all" the TAI-5 database made the mirror
# create a duplicate "TAI-5 activation probe" project every run (no anchor).
# Pass "…,all" explicitly to turn it back on.
# API looks them up on each run, so a newly shared database needs no rerun.
set -euo pipefail

ROOT=/opt/t-boards
# Workspaces the seeded admin owns; selftest.sh runs this same line on a fresh schema.
# The Notion boards are HR Helper's: its product (seed/products.json) wins
# when the admin owns several workspaces.
MIRROR_SLUG=hr-helper-lavaeon
OWNED_SQL="select w.id, w.name from workspace w join workspace_member m on m.workspace_id = w.id and m.role = 'owner' join \"user\" u on u.id = m.user_id where u.email = 'admin@t-boards.local' order by w.created_at"
PRODUCT_SQL="select w.id, w.name from workspace w where w.slug = '$MIRROR_SLUG'"
# «Задачи» and «Ошибки»: database ids for /v1/databases, not data-source ids.
databases="${1:-256853cd-b4ae-4394-a768-a2a2ebd3c5fe,714f2a2f-5274-485e-84ca-ee701ed5df19}"
workspace="${2:-}"
compose=(docker compose -p t-boards --project-directory "$ROOT" -f "$ROOT/compose.yml")

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "СТОП: $*"
  exit 1
}
sql() { "${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -At -F ' | ' -c "$1"; }

[ "$(id -u)" = 0 ] || die "нужен root"
[ -f "$ROOT/.env" ] || die "t-boards не установлен — сначала пункт s-tb-install"
[[ "$databases" =~ ^([0-9a-f-]{32,36}|all)(,([0-9a-f-]{32,36}|all))*$ ]] || die "id баз или all — через запятую, без пробелов"

if [ -z "$workspace" ]; then
  owned="$(sql "$PRODUCT_SQL")"
  [ -n "$owned" ] || owned="$(sql "$OWNED_SQL")"
  case "$(printf '%s' "$owned" | grep -c . || true)" in
    0) die "у admin@t-boards.local нет рабочего пространства: войдите в t-boards и создайте его, потом повторите" ;;
    1) workspace="${owned%% | *}" ;;
    *)
      printf '%s\n' "$owned"
      die "пространств несколько — передайте нужный id вторым аргументом"
      ;;
  esac
fi
[[ "$workspace" =~ ^[a-z0-9]+$ ]] || die "странный id пространства: $workspace"
log "пространство: $workspace"

read -r -s -p "Токен интеграции Notion (ntn_… или secret_…), ввод не виден: " token </dev/tty
echo
token="$(printf '%s' "$token" | tr -d '[:space:]')"
[[ "$token" =~ ^(ntn_|secret_)[A-Za-z0-9]{20,}$ ]] || die "это не похоже на токен интеграции Notion"

# The header goes through stdin so the token never shows up in the process list.
notion() {
  printf 'Authorization: Bearer %s\nNotion-Version: 2022-06-28\nContent-Type: application/json\n' "$token" |
    curl -sS --max-time 20 -H @- "$@"
}
for id in ${databases//,/ }; do
  [ "$id" = all ] && continue
  code="$(notion -o /dev/null -w '%{http_code}' "https://api.notion.com/v1/databases/$id")"
  [ "$code" = 200 ] || die "база $id: HTTP $code — поделитесь базой с интеграцией (… → Connections) и повторите"
  log "база $id читается"
done
if [[ ",$databases," == *,all,* ]]; then
  found="$(notion -X POST -d '{"filter":{"property":"object","value":"database"},"page_size":100}' \
    https://api.notion.com/v1/search | grep -o '"object":"database"' | grep -c . || true)"
  [ "$found" -gt 0 ] || die "all: интеграции не открыта ни одна база — … → Connections"
  log "all: интеграции открыто баз на первой странице поиска: $found"
fi

(
  umask 077
  printf '%s\n' "$token" >"$ROOT/secrets/notion_token.new"
)
unset token
chown 1001:1001 "$ROOT/secrets/notion_token.new"
chmod 0400 "$ROOT/secrets/notion_token.new"
mv "$ROOT/secrets/notion_token.new" "$ROOT/secrets/notion_token"
log "токен сохранён в $ROOT/secrets/notion_token (0400, uid 1001)"

backup="$ROOT/.env.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$ROOT/.env" "$backup"
{
  grep -v '^NOTION_MIRROR_\(WORKSPACE_ID\|DATABASES\)=' "$backup" || true
  echo "NOTION_MIRROR_WORKSPACE_ID=$workspace"
  echo "NOTION_MIRROR_DATABASES=$databases"
} >"$ROOT/.env"
chmod 0600 "$ROOT/.env"

"${compose[@]}" up -d app 2>&1 | tail -3
app="$("${compose[@]}" ps -q app)"
status=starting
for _ in $(seq 1 36); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$app")"
  [ "$status" = healthy ] && break
  sleep 5
done
[ "$status" = healthy ] || die "app не стал healthy (статус $status): docker compose -p t-boards logs app"
log "зеркало включено: прогон каждые 2 ч (в :07 по UTC); сразу — «Лес → Зеркало Notion → Запустить»"
log "откат: cp $backup $ROOT/.env && rm $ROOT/secrets/notion_token && docker compose -p t-boards up -d app"
