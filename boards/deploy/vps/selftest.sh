#!/usr/bin/env bash
# Local proof of the VPS kit before a delivery (Mac + Docker, amd64 under
# emulation). Runs the real compose.yml as project tb-selftest on an empty
# database, so migrations run from scratch, unlike the dev database.
# Checks: health, migrations = journal, admin and products seed, TLS proxy with a
# self-signed certificate, a backup dump and its restore, the memory sampler.
# Cleans up after itself.
# Usage: deploy/vps/selftest.sh <image-tag> <scratch-dir>
set -euo pipefail

tag="${1:?image tag}"
scratch="${2:?scratch dir}"
vps="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$vps/../.." && pwd)"
domain=d4dev.admin.hrhelper.space
project=tb-selftest
le_volume=tb-selftest-le
root="$(mktemp -d "$scratch/tb-selftest-XXXXXX")"
compose=(docker compose -p "$project" --project-directory "$root" -f "$root/compose.yml")

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() {
  log "FAIL: $*"
  exit 1
}
cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f tb-selftest-tls >/dev/null 2>&1 || true
  docker volume rm "$le_volume" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

lsof -nP -iTCP:5180 -sTCP:LISTEN >/dev/null 2>&1 && fail "port 5180 is busy"

for script in "$vps"/*.sh "$vps"/mac/*.sh; do bash -n "$script"; done
log "bash -n: ok"

# Same layout install.sh builds in /opt/t-boards.
mkdir -p "$root/secrets" "$root/backups"
chmod 777 "$root/backups"
cp "$vps/compose.yml" "$vps/backup.sh" "$root/"
for name in postgres_password auth_secret settings_key; do
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$root/secrets/$name"
done
printf 'TB_IMAGE=t-boards:%s\nTB_DOMAIN=%s\nTB_LE_VOLUME=%s\nNOTION_MIRROR_WORKSPACE_ID=\nNOTION_MIRROR_DATABASES=\n' \
  "$tag" "$domain" "$le_volume" >"$root/.env"

# Self-signed certificate where Let's Encrypt would put the real one.
mkdir -p "$root/cert"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$domain" \
  -keyout "$root/cert/privkey.pem" -out "$root/cert/fullchain.pem" >/dev/null 2>&1
docker volume create "$le_volume" >/dev/null
docker run --rm -v "$le_volume:/le" -v "$root/cert:/src:ro" --entrypoint sh nginx:1.27-alpine -c \
  "mkdir -p /le/live/$domain && cp /src/*.pem /le/live/$domain/"

"${compose[@]}" config --quiet || fail "compose config"
log "compose config: ok"
# backup starts after the seeds, so its first dump carries the seeded data.
"${compose[@]}" up -d postgres app 2>&1 | tail -3 || true

app_id="$("${compose[@]}" ps -q app)"
status=starting
for _ in $(seq 1 90); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$app_id")"
  [ "$status" = healthy ] && break
  sleep 5
done
[ "$status" = healthy ] || {
  "${compose[@]}" logs --tail 30 app
  fail "app is $status"
}
log "app healthy"

# TB-124: the memory sampler reads this project's containers and their limits.
mem="$(TB_COMPOSE_PROJECT="$project" TB_MEM_STATS_DIR="$root/mem-stats" bash "$vps/mem-stats.sh" sample 0 2>/dev/null)"
grep -qE $'\tapp\t[0-9]+\.[0-9]\t1024$' "$mem" || fail "mem-stats: no app row with the 1g limit in $mem"
log "mem-stats: $(cut -f2 "$mem" | sort | tr '\n' ' ')"

journal="$(node -e "process.stdout.write(String(require(process.argv[1]).entries.length))" \
  "$app/apps/api/drizzle/meta/_journal.json")"
applied="$("${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -Atc \
  'select count(*) from drizzle.__drizzle_migrations')"
[ "$applied" = "$journal" ] || fail "migrations: applied $applied, journal $journal"
log "migrations from scratch: $applied = journal $journal"

"${compose[@]}" exec -T app node /app/apps/api/dist/seed-local-admin.js 2>&1 | tail -2
"${compose[@]}" exec -T app node /app/apps/api/dist/seed-local-admin.js 2>&1 | tail -1
admins="$("${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -Atc \
  "select count(*) from \"user\" where email = 'admin@t-boards.local'")"
[ "$admins" = 1 ] || fail "admin rows: $admins"
log "seed: one admin after two runs"

"${compose[@]}" exec -T app node /app/apps/api/dist/seed-products.js <"$vps/seed/products.json" 2>&1 | tail -1
again="$("${compose[@]}" exec -T app node /app/apps/api/dist/seed-products.js <"$vps/seed/products.json" 2>&1 | tail -1)"
printf '%s\n' "$again"
[[ "$again" == "products: +0 "*"cards: +0 "*"links: +0 "* ]] || fail "second products seed changed something: $again"
log "seed: products and links added once, kept on the second run"

# mirror-setup.sh picks the workspace with these exact lines: the HR Helper
# product first, the admin's only workspace otherwise.
eval "$(grep -E '^(MIRROR_SLUG|OWNED_SQL|PRODUCT_SQL)=' "$vps/mirror-setup.sh")"
if [ -z "${PRODUCT_SQL:-}" ] || [ -z "${OWNED_SQL:-}" ]; then fail "lookup SQL not found in mirror-setup.sh"; fi
product="$("${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -At -F ' | ' -c "$PRODUCT_SQL")"
[[ "$product" =~ ^[a-z0-9]+\ \|\ HR\ Helper\ /\ Lavaeon$ ]] || fail "mirror-setup product lookup returned: $product"
owned="$("${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -At -F ' | ' -c "$OWNED_SQL" | grep -c .)"
[ "$owned" = 3 ] || fail "admin owns $owned workspaces, expected the 3 products"
log "mirror-setup lookup: HR Helper product, admin owns 3 products"

signup="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"email":"intruder@example.test","password":"intruder-pass-1","name":"x"}' \
  http://127.0.0.1:5180/api/auth/sign-up/email)"
[ "$signup" != 200 ] || fail "sign-up is open"
[ "$signup" != 404 ] || fail "sign-up path not found; the check proves nothing"
log "sign-up refused: HTTP $signup"

# The VPS runs tls with host networking on the WireGuard address; here the
# same rendered config listens in a bridge container and reaches the app on
# the host port.
bash "$vps/render-tls.sh" "$vps/tls.conf.template" "$root/tls.conf" \
  8443 "$domain" host.docker.internal:5180 || fail "tls.conf not rendered"
docker run -d --name tb-selftest-tls -p 127.0.0.1:18443:8443 \
  -v "$root/tls.conf:/etc/nginx/nginx.conf:ro" -v "$le_volume:/etc/letsencrypt:ro" \
  nginx:1.27-alpine >/dev/null
sleep 2
docker exec tb-selftest-tls nginx -t 2>&1 | tail -1
health="$(curl -sk --resolve "$domain:18443:127.0.0.1" "https://$domain:18443/api/health")"
[ -n "$health" ] || fail "no answer through tls"
hsts="$(curl -skI --resolve "$domain:18443:127.0.0.1" "https://$domain:18443/" | grep -ci '^strict-transport-security' || true)"
[ "$hsts" -ge 1 ] || fail "no HSTS header"
log "tls proxy: $health, HSTS present"

"${compose[@]}" up -d backup 2>&1 | tail -1 || true
for _ in $(seq 1 30); do
  [ -s "$root/backups/latest.dump" ] && break
  sleep 2
done
[ "$(head -c 5 "$root/backups/latest.dump")" = PGDMP ] || fail "no backup dump"
log "backup: $(wc -c <"$root/backups/latest.dump" | tr -d ' ') bytes"
restored="$(sh "$vps/mac/restore-check.sh" "$root/backups/latest.dump")" || fail "restore-check"
printf '%s\n' "$restored"
printf '%s\n' "$restored" | grep -qx "migrations $journal" || fail "restored dump lacks $journal migrations"
cards="$(grep -c -E '"key": "[A-Z]{2,5}-[0-9]{3}"' "$vps/seed/products.json")"
for row in "users 1" "workspaces 3" "tasks $cards"; do
  printf '%s\n' "$restored" | grep -qx "$row" || fail "restored dump lacks $row"
done
log "restore: $journal migrations, the admin, 3 products and $cards cards back"

log "selftest: all checks passed"
