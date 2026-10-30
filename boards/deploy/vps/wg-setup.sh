#!/usr/bin/env bash
# WireGuard on the VPS for t-boards (scheme A, R-006). Each device is a peer in
# one of two modes:
#   split — only 10.77.0.0/24 goes through the VPS (t-boards and nothing else);
#   full  — all traffic goes through the VPS and leaves to the internet from
#           its address, like an ordinary VPN.
# t-boards is reachable only through the tunnel in both modes; the product's
# public sites stay as they are and need no VPN.
# Idempotent: the first run creates wg0, later runs add a peer and upgrade the
# firewall rules of an older wg0. A new peer gets a preshared key, printed once
# with its config block; a peer that is already there keeps what it has.
# Usage: wg-setup.sh [PEER_PUBLIC_KEY [LABEL [split|full]]]   (asks for the key when omitted)
set -euo pipefail

WG_IF=wg0
WG_NET=10.77.0
WG_PORT=51820
TLS_PORT=8443
CONF=/etc/wireguard/$WG_IF.conf
RULES=/etc/wireguard/t-boards-rules.sh
SYSCTL=/etc/sysctl.d/99-t-boards-wg.conf
TB_ENV=/opt/t-boards/.env
# Bridge and app address of the t-boards compose network (compose.yml, networks.tb).
TB_BRIDGE=br-tboards
TB_APP_IP=10.78.0.2
FULL_DNS="1.1.1.1, 9.9.9.9"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() {
  log "СТОП: $*"
  exit 1
}

[ "$(id -u)" = 0 ] || die "нужен root"

peer_pub="${1:-}"
label="${2:-mac}"
mode="${3:-split}"
case "$mode" in split | full) ;; *) die "режим — split или full, не «$mode»" ;; esac
[[ "$label" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || die "имя устройства — латиница, цифры, . _ -"
if [ -z "$peer_pub" ]; then
  read -r -p "Публичный ключ устройства (приложение WireGuard → Public key): " peer_pub </dev/tty
fi
peer_pub="$(printf '%s' "$peer_pub" | tr -d '[:space:]')"
[[ "$peer_pub" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "это не публичный ключ WireGuard"

if ! command -v wg >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "нет apt-get — поставьте wireguard-tools вручную"
  log "ставлю wireguard-tools"
  apt-get update -qq 2>&1 | tail -2
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard-tools 2>&1 | tail -2
fi

route="$(ip -4 route get 1.1.1.1)"
public_ip="$(awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' <<<"$route")"
ext_if="$(awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}' <<<"$route")"
if [ -z "$public_ip" ] || [ -z "$ext_if" ]; then die "не нашёл публичный IP и внешний интерфейс"; fi
log "внешний интерфейс $ext_if, адрес $public_ip"

# The app reads the Mac's claude-mem proxy through the tunnel; install.sh keeps
# its address in .env. Only that proxy may answer a container: every container
# on the VPS leaves the tunnel as 10.77.0.1, so a wider rule would hand all of
# them the Mac's other services.
mem_host="" mem_port=""
if [ -r "$TB_ENV" ]; then
  mem_host="$(sed -n 's/^CLAUDE_MEM_WORKER_HOST=//p' "$TB_ENV" | tail -1)"
  mem_port="$(sed -n 's/^CLAUDE_MEM_WORKER_PORT=//p' "$TB_ENV" | tail -1)"
fi
: "${mem_host:=$WG_NET.2}" "${mem_port:=37702}"
if ! [[ "${mem_host#"$WG_NET".}" =~ ^[0-9]{1,3}$ && "$mem_port" =~ ^[0-9]{1,5}$ ]]; then
  log "память $mem_host:$mem_port — не адрес туннеля, беру $WG_NET.2:37702"
  mem_host=$WG_NET.2 mem_port=37702
fi

# Firewall rules live in one script that wg-quick runs on up and down, so an
# upgrade rewrites them in one place.
# - 443 to the tunnel address goes to the t-boards TLS terminator. Only that
#   address: in full mode the device reaches the product's public sites on the
#   same VPS through the tunnel, and they must keep landing on the edge nginx.
# - Full-tunnel devices leave through the external interface (NAT). The tunnel
#   may forward only there and to the product's published ports (Docker DNAT,
#   the same reach the internet has): its internal networks stay out of reach.
#   Containers may not open connections into the tunnel, except the t-boards
#   app (bridge and address fixed in compose.yml) to the claude-mem proxy; the
#   proxy's replies are the one way back in, and only to the app. The VPS host
#   and host-network containers do not pass FORWARD: OUTPUT shuts the proxy to them.
#   The forwarding rules sit in their own chain, rebuilt in order on every up.
# - Nothing from outside may address the tunnel network directly.
write_rules() {
  local tmp
  tmp="$(mktemp "$RULES.XXXXXX")"
  cat >"$tmp" <<EOF
#!/usr/bin/env bash
# Written by wg-setup.sh. Usage: $RULES up|down $WG_IF
set -u
action="\$1"
wg_if="\${2:-$WG_IF}"
ext_if=$ext_if
CHAIN=TB-WG
rule() {
  if [ "\$action" = up ]; then
    iptables "\$@" -C "\${spec[@]}" 2>/dev/null || iptables "\$@" -I "\${spec[@]}"
  else
    while iptables "\$@" -D "\${spec[@]}" 2>/dev/null; do :; done
  fi
}
spec=(PREROUTING -i "\$wg_if" -d $WG_NET.1 -p tcp --dport 443 -j REDIRECT --to-ports $TLS_PORT)
rule -t nat
spec=(POSTROUTING -s $WG_NET.0/24 -o "\$ext_if" -j MASQUERADE)
rule -t nat
spec=(INPUT -i "\$ext_if" -d $WG_NET.0/24 -j DROP)
rule -t filter

if [ "\$action" = up ]; then
  iptables -N "\$CHAIN" 2>/dev/null || iptables -F "\$CHAIN"
  iptables -A "\$CHAIN" -i "\$wg_if" -o "\$ext_if" -j ACCEPT
  iptables -A "\$CHAIN" -i "\$ext_if" -o "\$wg_if" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A "\$CHAIN" -i $TB_BRIDGE -o "\$wg_if" -s $TB_APP_IP -d $mem_host -p tcp --dport $mem_port -m conntrack --ctstate NEW -j RETURN
  iptables -A "\$CHAIN" -o "\$wg_if" -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP
  iptables -A "\$CHAIN" -i "\$wg_if" -o $TB_BRIDGE -d $TB_APP_IP -s $mem_host -p tcp --sport $mem_port -m conntrack --ctstate ESTABLISHED -j RETURN
  iptables -A "\$CHAIN" -i "\$wg_if" -m conntrack --ctstate DNAT -j RETURN
  iptables -A "\$CHAIN" -i "\$wg_if" -j DROP
  # Its own chain too: a changed memory address must not leave the old rule.
  iptables -N "\$CHAIN-OUT" 2>/dev/null || iptables -F "\$CHAIN-OUT"
  iptables -A "\$CHAIN-OUT" -o "\$wg_if" -d $mem_host -p tcp --dport $mem_port -j DROP
fi
spec=(FORWARD -j "\$CHAIN")
rule -t filter
spec=(OUTPUT -j "\$CHAIN-OUT")
rule -t filter
# Docker evaluates DOCKER-USER before its own rules, also after it restarts. When wg0 comes
# up first (boot), the chain is made here: Docker keeps it and jumps to it ahead of its accepts.
# down leaves the chain itself, it belongs to Docker.
if [ "\$action" = up ]; then
  iptables -N DOCKER-USER 2>/dev/null || true
fi
spec=(DOCKER-USER -j "\$CHAIN")
rule -t filter
if [ "\$action" = up ]; then
  sysctl -q -w net.ipv4.ip_forward=1
else
  iptables -F "\$CHAIN" 2>/dev/null && iptables -X "\$CHAIN" 2>/dev/null
  iptables -F "\$CHAIN-OUT" 2>/dev/null && iptables -X "\$CHAIN-OUT" 2>/dev/null
fi
exit 0
EOF
  chmod 0755 "$tmp"
  mv "$tmp" "$RULES"
}

umask 077
mkdir -p /etc/wireguard
# wg-issue.sh and wg-psk.sh take the same lock: one edit of wg0.conf at a time.
exec 9>"$CONF.lock"
flock -w 60 9 || die "$CONF занят другим скриптом дольше минуты"
# Backups hold the server PrivateKey: only the newest three stay.
backup() {
  local old=("$CONF".bak-[0-9]*) last dst base n=0
  last="${old[${#old[@]}-1]}"
  # A re-run that changes nothing must not push the last real state out.
  [ -e "$last" ] && cmp -s "$CONF" "$last" && return 0
  dst="$CONF.bak-$(date +%Y%m%d-%H%M%S)"
  # The copy has to sort after every kept one, or the pruning below drops it first: an edit
  # within the same second, or after the clock went back, takes the newest name plus -01, -02.
  if [ -e "$last" ] && [[ ! "$dst" > "$last" ]]; then
    base="${last%-[0-9][0-9]}"
    [ "$base" = "$last" ] || n="${last##*-}"
    # Past -99 the next name would sort first and be pruned at once.
    [ $((10#$n)) -lt 99 ] || die "копии $CONF с одним временем дошли до -99 — проверьте часы (date) и лишние $CONF.bak-*"
    printf -v dst '%s-%02d' "$base" $((10#$n + 1))
  fi
  cp -a "$CONF" "$dst"
  old=("$CONF".bak-[0-9]*)
  [ "${#old[@]}" -le 3 ] || rm -f -- "${old[@]:0:${#old[@]}-3}"
}
write_rules
printf 'net.ipv4.ip_forward = 1\n' >"$SYSCTL"

if [ ! -f "$CONF" ]; then
  if ip -4 -o addr show | grep -q " $WG_NET\." || ip -4 route show | grep -q "^$WG_NET\."; then
    die "сеть $WG_NET.0/24 уже занята на VPS — нужна другая подсеть"
  fi
  log "создаю $CONF"
  private="$(wg genkey)"
  cat >"$CONF" <<EOF
[Interface]
Address = $WG_NET.1/24
ListenPort = $WG_PORT
PrivateKey = $private
PostUp = $RULES up %i
PostDown = $RULES down %i
EOF
  unset private
else
  backup
  if ! grep -q "^PostUp = $RULES up %i\$" "$CONF"; then
    # wg0 from the first kit: its 443 redirect matched any destination.
    log "обновляю правила $CONF"
    iptables -t nat -D PREROUTING -i "$WG_IF" -p tcp --dport 443 -j REDIRECT --to-ports "$TLS_PORT" 2>/dev/null || true
    sed -i -e '/^PostUp = /d' -e '/^PostDown = /d' -e '/^# The edge nginx of the product owns/d' \
      -e '/^# goes to the t-boards TLS terminator/d' "$CONF"
    sed -i "/^PrivateKey = /a PostUp = $RULES up %i\nPostDown = $RULES down %i" "$CONF"
  fi
fi

psk=""
if grep -q "^PublicKey = $peer_pub\$" "$CONF"; then
  peer_ip="$(awk -v k="$peer_pub" '$1 == "PublicKey" && $3 == k {found = 1} found && $1 == "AllowedIPs" {split($3, a, "/"); print a[1]; exit}' "$CONF")"
  log "устройство уже есть: $peer_ip"
  # A key added here would cut off a device that does not have it yet; wg-psk.sh changes it.
  if awk -v k="$peer_pub" '/^\[/ {found = 0} $1 == "PublicKey" {found = ($3 == k)} found && $1 == "PresharedKey" {exit 1}' "$CONF"; then
    log "PresharedKey у устройства нет. Добавить: ssh -t root@<VPS> 'bash /opt/t-boards/wg-psk.sh $peer_ip' (ввод ключа скрыт)"
    log "и та же строка PresharedKey = <ключ> в туннеле на устройстве (README, wg-psk.sh)"
  else
    log "PresharedKey у устройства уже есть: строку PresharedKey на устройстве не трогайте"
  fi
else
  last="$({ grep -E "^AllowedIPs = $WG_NET\.[0-9]+/32" "$CONF" || true; } | sed -E 's|.*\.([0-9]+)/32|\1|' | sort -n | tail -1)"
  next=$((${last:-1} + 1))
  [ "$next" -le 254 ] || die "в $WG_NET.0/24 кончились адреса"
  peer_ip="$WG_NET.$next"
  psk="$(wg genpsk)"
  printf '\n[Peer]\n# %s (%s)\nPublicKey = %s\nPresharedKey = %s\nAllowedIPs = %s/32\n' \
    "$label" "$mode" "$peer_pub" "$psk" "$peer_ip" >>"$CONF"
  log "добавлено устройство $label ($mode): $peer_ip"
fi

if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$WG_PORT/udp" >/dev/null
  ufw allow in on "$WG_IF" >/dev/null
  log "ufw: открыт $WG_PORT/udp и вход через $WG_IF"
else
  log "ufw не активен; политика INPUT: $(iptables -S INPUT 2>&1 | head -1)"
fi

systemctl enable "wg-quick@$WG_IF" >/dev/null 2>&1
if systemctl is-active --quiet "wg-quick@$WG_IF"; then
  wg syncconf "$WG_IF" <(wg-quick strip "$WG_IF")
  "$RULES" up "$WG_IF"
else
  systemctl start "wg-quick@$WG_IF"
fi

ip -4 -o addr show "$WG_IF" | grep -q " $WG_NET.1/" || die "$WG_IF не поднялся: systemctl status wg-quick@$WG_IF"
iptables -t nat -C PREROUTING -i "$WG_IF" -d "$WG_NET.1" -p tcp --dport 443 -j REDIRECT --to-ports "$TLS_PORT" ||
  die "нет правила 443 → $TLS_PORT на $WG_IF"
iptables -t nat -C POSTROUTING -s "$WG_NET.0/24" -o "$ext_if" -j MASQUERADE || die "нет NAT для туннеля"
[ "$(sysctl -n net.ipv4.ip_forward)" = 1 ] || die "ip_forward выключен"
if [ -n "$psk" ]; then
  wg show "$WG_IF" preshared-keys | awk -v k="$peer_pub" '$1 == k && $2 != "(none)" { found = 1 } END { exit !found }' ||
    die "у нового пира в $WG_IF нет PresharedKey"
fi

if [ "$mode" = full ]; then
  allowed="0.0.0.0/0, ::/0"
  dns="DNS = $FULL_DNS"
else
  allowed="$WG_NET.0/24"
  dns=""
fi
vps_pub="$(wg show "$WG_IF" public-key)"
psk_line=""
[ -z "$psk" ] || psk_line="PresharedKey = $psk"$'\n'
log "wg0 поднят. Вставьте в туннель на устройстве сразу под строкой PrivateKey (её не трогайте):"
[ -z "$psk" ] || log "В блоке секрет (PresharedKey): только в WireGuard на устройстве, не в очередь, чат и заметки"
# MTU 1380, as on the Mac since OPS-012: room for paths narrower than 1500.
cat <<EOF

Address = $peer_ip/32
MTU = 1380
$dns

[Peer]
PublicKey = $vps_pub
${psk_line}Endpoint = $public_ip:$WG_PORT
AllowedIPs = $allowed
PersistentKeepalive = 25

EOF
unset psk psk_line
log "Проверка с устройства: ping $WG_NET.1; в режиме full ещё — внешний IP должен стать $public_ip"
log "Откат: systemctl disable --now wg-quick@$WG_IF && mv $CONF $CONF.off && rm -f $SYSCTL"
