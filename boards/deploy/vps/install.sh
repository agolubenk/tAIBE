#!/usr/bin/env bash
# Installs or updates t-boards on the VPS from an unpacked bundle (bundle.sh).
# Run from anywhere: bash /opt/t-boards/releases/<tag>/install.sh
# Every step prints what it did; any failure stops with the reason and the
# previous release keeps running (rollback: .env.prev, see README).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$here/VERSION"
ROOT=/opt/t-boards
DOMAIN=d4dev.admin.hrhelper.space
WG_ADDR=10.77.0.1
TLS_PORT=8443
compose=(docker compose -p t-boards --project-directory "$ROOT" -f "$ROOT/compose.yml")

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "СТОП: $*"
  exit 1
}

preflight() {
  [ "$(id -u)" = 0 ] || die "нужен root"
  docker compose version >/dev/null 2>&1 || die "нет docker compose v2"
  command -v curl >/dev/null 2>&1 || die "нет curl"
  ip -4 -o addr show wg0 2>/dev/null | grep -q " $WG_ADDR/" || die "wg0 не поднят — сначала пункт s-tb-wg"
  local mem disk
  mem="$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)"
  disk="$(df -Pm /opt | awk 'NR == 2 {print $4}')"
  log "свободно: память ${mem} МБ, диск /opt ${disk} МБ"
  [ "$mem" -ge 900 ] || die "меньше 900 МБ свободной памяти"
  [ "$disk" -ge 3000 ] || die "меньше 3 ГБ на диске"
}

# The product's certbot sidecar owns the webroot and the certificate volume;
# reusing both means its renew loop covers our certificate too.
find_certbot_volumes() {
  local cb
  cb="$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^certbot\/certbot/ {print $1; exit}')"
  [ -n "$cb" ] || die "не нашёл контейнер certbot продукта"
  CERTBOT_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$cb")"
  LE_VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/letsencrypt"}}{{.Name}}{{end}}{{end}}' "$cb")"
  WWW_VOLUME="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/www/certbot"}}{{.Name}}{{end}}{{end}}' "$cb")"
  if [ -z "$LE_VOLUME" ] || [ -z "$WWW_VOLUME" ]; then
    die "у $cb нет именованных томов /etc/letsencrypt и /var/www/certbot"
  fi
  log "certbot: $cb, тома $LE_VOLUME и $WWW_VOLUME"
}

ensure_certificate() {
  if docker run --rm --entrypoint test -v "$LE_VOLUME:/etc/letsencrypt:ro" "$CERTBOT_IMAGE" \
    -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
    log "сертификат $DOMAIN уже есть"
    return
  fi
  # Prove the ACME webroot answers for our name before asking Let's Encrypt.
  local probe answer
  probe="tb-probe-$RANDOM$RANDOM"
  docker run --rm --entrypoint sh -v "$WWW_VOLUME:/w" "$CERTBOT_IMAGE" -c \
    "mkdir -p /w/.well-known/acme-challenge && echo ok > /w/.well-known/acme-challenge/$probe"
  answer="$(curl -fsS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/$probe" 2>&1 || true)"
  docker run --rm --entrypoint rm -v "$WWW_VOLUME:/w" "$CERTBOT_IMAGE" -f "/w/.well-known/acme-challenge/$probe"
  [ "$answer" = "ok" ] || die "ACME webroot не отвечает для $DOMAIN: $answer"
  log "выпускаю сертификат $DOMAIN"
  docker run --rm -v "$LE_VOLUME:/etc/letsencrypt" -v "$WWW_VOLUME:/var/www/certbot" "$CERTBOT_IMAGE" \
    certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring 2>&1 | tail -6
  docker run --rm --entrypoint test -v "$LE_VOLUME:/etc/letsencrypt:ro" "$CERTBOT_IMAGE" \
    -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" || die "сертификат не появился"
}

random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

ensure_secrets() {
  install -d -m 0711 "$ROOT/secrets"
  local name file
  # settings_key seals the model key an admin saves (TB-67); replacing it
  # later makes that key unreadable until it is entered again.
  for name in postgres_password auth_secret settings_key; do
    file="$ROOT/secrets/$name"
    if [ ! -s "$file" ]; then
      (
        umask 077
        random_hex >"$file"
      )
      log "создан секрет $name"
    fi
  done
  # Postgres (uid 70) and the app (uid 1001) both read the database password.
  chown 70:1001 "$ROOT/secrets/postgres_password"
  chmod 0440 "$ROOT/secrets/postgres_password"
  for name in auth_secret settings_key; do
    chown 1001:1001 "$ROOT/secrets/$name"
    chmod 0400 "$ROOT/secrets/$name"
  done
  for optional in notion_token notebook_llm_key claude_mem_proxy_token; do
    if [ -f "$ROOT/secrets/$optional" ]; then
      chown 1001:1001 "$ROOT/secrets/$optional"
      chmod 0400 "$ROOT/secrets/$optional"
    fi
  done
  # The Mac owns the memory proxy token (OPS-19): it is delivered, never made here.
  [ -s "$ROOT/secrets/claude_mem_proxy_token" ] ||
    log "ВНИМАНИЕ: нет secrets/claude_mem_proxy_token — app читает память без токена, это работает, только пока прокси Mac в режиме раскатки; доставка — mac/memory-token-push.sh"
}

write_files() {
  install -d -m 0755 "$ROOT"
  install -d -m 0750 -o 70 -g 70 "$ROOT/backups"
  install -m 0644 "$here/compose.yml" "$ROOT/compose.yml"
  install -m 0644 "$here/backup.sh" "$ROOT/backup.sh"
  install -m 0700 "$here/backup-key.sh" "$ROOT/backup-key.sh"
  install -m 0700 "$here/wg-setup.sh" "$ROOT/wg-setup.sh"
  install -m 0700 "$here/wg-issue.sh" "$ROOT/wg-issue.sh"
  install -m 0700 "$here/wg-psk.sh" "$ROOT/wg-psk.sh"
  install -m 0700 "$here/mirror-setup.sh" "$ROOT/mirror-setup.sh"
  install -m 0700 "$here/mem-stats.sh" "$ROOT/mem-stats.sh"
  bash "$here/render-tls.sh" "$here/tls.conf.template" "$ROOT/tls.conf" \
    "$WG_ADDR:$TLS_PORT" "$DOMAIN" 127.0.0.1:5180 || die "tls.conf не отрендерился"

  # Keep the mirror, notebook, claude-mem and owner-queue settings the owner
  # already filled in.
  [ -f "$ROOT/.env" ] && cp -a "$ROOT/.env" "$ROOT/.env.prev"
  local kept=""
  if [ -f "$ROOT/.env.prev" ]; then
    kept="$(grep -E '^(NOTION_MIRROR|NOTEBOOK_LLM|CLAUDE_MEM|OQ)_' "$ROOT/.env.prev" || true)"
  fi
  {
    echo "TB_IMAGE=t-boards:$TB_TAG"
    echo "TB_DOMAIN=$DOMAIN"
    echo "TB_LE_VOLUME=$LE_VOLUME"
    if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
    for var in NOTION_MIRROR_WORKSPACE_ID NOTION_MIRROR_DATABASES; do
      grep -q "^$var=" <<<"$kept" || echo "$var="
    done
    # The Mac's read-only claude-mem proxy listens on its tunnel address.
    grep -q "^CLAUDE_MEM_WORKER_HOST=" <<<"$kept" || echo "CLAUDE_MEM_WORKER_HOST=10.77.0.2"
    grep -q "^CLAUDE_MEM_WORKER_PORT=" <<<"$kept" || echo "CLAUDE_MEM_WORKER_PORT=37702"
  } >"$ROOT/.env"
  chmod 0600 "$ROOT/.env"
}

# The app's fixed address and its bridge, the pair the tunnel lets through to the memory proxy.
app_ip() { sed -n '/^  app:/,/^  [a-z]/s/^ *ipv4_address: //p' "$ROOT/compose.yml"; }
app_bridge() { sed -n 's/^ *com\.docker\.network\.bridge\.name: //p' "$ROOT/compose.yml"; }

# wg-setup.sh lets the t-boards app reach the claude-mem proxy at the address
# in .env (OPS-19: only the app); this script does not re-run it.
check_tunnel_rules() {
  local host port app bridge rules=/etc/wireguard/t-boards-rules.sh
  host="$(sed -n 's/^CLAUDE_MEM_WORKER_HOST=//p' "$ROOT/.env" | tail -1)"
  port="$(sed -n 's/^CLAUDE_MEM_WORKER_PORT=//p' "$ROOT/.env" | tail -1)"
  app="$(app_ip)"
  bridge="$(app_bridge)"
  { grep -qF -e "-i $bridge -o \"\$wg_if\" -s $app -d $host -p tcp --dport $port " "$rules" &&
    grep -qF -e "-i \"\$wg_if\" -o $bridge -d $app -s $host -p tcp --sport $port " "$rules"; } 2>/dev/null ||
    log "ВНИМАНИЕ: туннель не пускает t-boards ($app, мост $bridge) к памяти $host:$port — перезапустите $ROOT/wg-setup.sh с ключом Mac"
}

load_image() {
  log "загружаю образ t-boards:$TB_TAG"
  docker load -i "$here/image.tar.gz" | tail -1
  local arch
  arch="$(docker image inspect -f '{{.Architecture}}' "t-boards:$TB_TAG")"
  [ "$arch" = "amd64" ] || die "образ собран под $arch, нужен amd64"
}

backup_before_update() {
  [ -n "$("${compose[@]}" ps -q postgres 2>/dev/null)" ] || return 0
  local file
  file="$ROOT/backups/pre-$TB_TAG-$(date +%Y%m%d-%H%M%S).dump"
  "${compose[@]}" exec -T postgres pg_dump -Fc -U t_boards t_boards >"$file"
  chown 70:70 "$file"
  log "бэкап перед обновлением: $file ($(wc -c <"$file") байт)"
}

start_and_wait() {
  # up waits for app health (backup depends on it) and fails if the app never
  # gets there; the loop below then prints the logs and the reason.
  "${compose[@]}" up -d --remove-orphans 2>&1 | tail -8 || true
  local app status _
  app="$("${compose[@]}" ps -q app)"
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$app" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && break
    sleep 5
  done
  if [ "$status" != healthy ]; then
    "${compose[@]}" logs --tail 40 app 2>&1
    die "app не стал healthy за 5 минут (статус $status)"
  fi
  log "app healthy"
  # The tunnel lets only this address reach the claude-mem proxy (OPS-19). up
  # fails without recreating anything when the subnet is taken; the app then
  # still runs on its old network.
  local want got
  want="$(app_ip)"
  got="$(docker inspect -f '{{with index .NetworkSettings.Networks "t-boards_tb"}}{{.IPAddress}}{{end}}' "$app")"
  [ "$got" = "$want" ] || die "app не в сети t-boards_tb с адресом $want (сейчас «$got»): подсеть занята? docker network ls"
  # Before OPS-19 the stack ran on the default network; it is empty now, and an
  # older compose.yml recreates it.
  docker network rm t-boards_default >/dev/null 2>&1 || true
}

check_migrations() {
  local applied
  applied="$("${compose[@]}" exec -T postgres psql -U t_boards -d t_boards -Atc \
    'select count(*) from drizzle.__drizzle_migrations' 2>&1)"
  log "миграции: в базе $applied, в образе $TB_MIGRATIONS"
  [ "$applied" = "$TB_MIGRATIONS" ] || die "число миграций не совпало"
}

seed_admin() {
  "${compose[@]}" exec -T app node /app/apps/api/dist/seed-local-admin.js 2>&1 | tail -3
}

# Products and their starting cards (seed/products.json). Adds what is missing
# and brings cards nobody has edited to the plan; an edit made in the UI stays.
seed_products() {
  [ -f "$here/seed/products.json" ] || {
    log "нет seed/products.json — продукты не трогаю"
    return
  }
  "${compose[@]}" exec -T app node /app/apps/api/dist/seed-products.js <"$here/seed/products.json" 2>&1 | tail -3
}

smoke() {
  local health tls_state
  health="$(curl -fsS --max-time 10 --resolve "$DOMAIN:$TLS_PORT:$WG_ADDR" \
    "https://$DOMAIN:$TLS_PORT/api/health" 2>&1 || true)"
  tls_state="$(docker inspect -f '{{.State.Status}}' "$("${compose[@]}" ps -q tls)" 2>&1)"
  log "tls: $tls_state; https://$DOMAIN/api/health через туннель: $health"
  if [ -z "$health" ] || [[ "$health" == curl:* ]]; then die "TLS не отвечает: docker compose -p t-boards logs tls"; fi
  log "кто слушает $TLS_PORT: $(ss -ltnH "sport = :$TLS_PORT" | awk '{print $4}' | tr '\n' ' ')"
}

main() {
  log "t-boards $TB_TAG ($TB_COMMIT)"
  preflight
  find_certbot_volumes
  ensure_certificate
  ensure_secrets
  load_image
  backup_before_update
  write_files
  check_tunnel_rules
  start_and_wait
  check_migrations
  seed_admin
  seed_products
  smoke
  log "готово: https://$DOMAIN (через WireGuard), вход admin / admin"
  log "откат: cd $ROOT && cp .env.prev .env && docker compose -p t-boards up -d"
}

main "$@"
