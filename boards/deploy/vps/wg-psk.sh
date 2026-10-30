#!/usr/bin/env bash
# Sets or removes the WireGuard preshared key of one wg0 peer, found by its tunnel address.
# The key arrives by hidden input or on stdin, so it never shows up in argv, the terminal or logs.
#   set:    ssh -t root@vps 'bash /opt/t-boards/wg-psk.sh 10.77.0.2'                (asks for the key, hidden)
#           wg genpsk | tee >(pbcopy) | ssh root@vps 'bash /opt/t-boards/wg-psk.sh 10.77.0.2'
#   remove: ssh -n root@vps 'bash /opt/t-boards/wg-psk.sh --remove 10.77.0.2'      (the rollback)
# Not through `base64 -d | bash`: stdin would be the script itself. A re-run replaces the key.
set -euo pipefail
umask 077

WG_IF=wg0
CONF=/etc/wireguard/$WG_IF.conf
mode="set"
if [ "${1:-}" = --remove ]; then
  mode="remove"
  shift
fi
ip="${1:-}"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
rollback=""
die() {
  log "СТОП: $*"
  [ -z "$rollback" ] || log "Откат: $rollback"
  exit 1
}

[ "$(id -u)" = 0 ] || die "нужен root"
[[ "$ip" =~ ^10\.77\.0\.([2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$ ]] || die "адрес устройства — 10.77.0.2…254, не «$ip»"
[ -f "$CONF" ] || die "нет $CONF — сначала wg-setup.sh"
# wg-setup.sh and wg-issue.sh take the same lock: one edit of wg0.conf at a time.
exec 9>"$CONF.lock"
flock -w 60 9 || die "$CONF занят другим скриптом дольше минуты"
wg show "$WG_IF" >/dev/null 2>&1 || die "$WG_IF не поднят: systemctl status wg-quick@$WG_IF"
# The backup holds the server PrivateKey: root-only, one file, kept only until the live check passes.
# One left over is the only way back from a failed run; a new run must not overwrite it.
backup="$CONF.bak-psk"
# The way back clears the peer's live key first: an older wg syncconf keeps a key that is no
# longer in the file. The peer's public key lies next to the backup for a later run to name it.
undo() { echo "cp $backup $CONF && wg set $WG_IF peer $1 preshared-key /dev/null && wg syncconf $WG_IF <(wg-quick strip $WG_IF) && rm -f $backup $backup.peer"; }
if [ -e "$backup" ]; then
  left="$(cat "$backup.peer" 2>/dev/null || true)"
  [[ "$left" =~ ^[A-Za-z0-9+/]{43}=$ ]] || left="<PublicKey устройства>"
  die "остался $backup от прерванного запуска — сначала откат: $(undo "$left")"
fi

psk=""
if [ "$mode" = set ]; then
  if [ -t 0 ]; then
    read -r -s -p "PresharedKey (ввод скрыт): " psk
    echo
  else
    psk="$(head -c 256 | tr -d '[:space:]')"
  fi
  [[ "$psk" =~ ^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]] || die "на входе не ключ WireGuard (32 байта в base64)"
fi

# Sections are numbered by their [headers]; the edit targets the peer's section, whatever the
# order of its lines. Keys are matched like wg does: any case, spaces around "=" optional.
# shellcheck disable=SC2016
AWK_KV='function kv() { k = tolower($0); sub(/[ \t]*=.*/, "", k); sub(/^[ \t]+/, "", k)
  v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t]+$/, "", v) }
  /^[ \t]*\[/ { s++ } { kv() }'

# Section number and public key of the [Peer] whose AllowedIPs contain exactly this /32.
# shellcheck disable=SC2016
peers="$(awk -v want="$ip/32" "$AWK_KV"'
  /^[ \t]*\[/ { flush(); peer = ($0 ~ /^[ \t]*\[[Pp][Ee][Ee][Rr]\][ \t]*$/); sec = s; next }
  function flush() { if (peer && hit) print sec, pub; peer = 0; hit = 0; pub = "" }
  peer && k == "publickey" { pub = v }
  peer && k == "allowedips" {
    n = split(v, a, ",")
    for (i = 1; i <= n; i++) { gsub(/[ \t]/, "", a[i]); if (a[i] == want) hit = 1 }
  }
  END { flush() }' "$CONF")"
[ -n "$peers" ] || die "в $CONF нет устройства с адресом $ip"
[ "$(printf '%s\n' "$peers" | wc -l)" -eq 1 ] || die "адрес $ip у нескольких устройств — правьте $CONF вручную"
read -r sect pub <<<"$peers"
[[ "$pub" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "у устройства $ip нечитаемый PublicKey"
wg show "$WG_IF" peers | grep -xF "$pub" >/dev/null || die "устройство $ip есть в $CONF, но не в живом $WG_IF"

# Rewrite the file: drop that peer's PresharedKey lines; in set mode add one after its PublicKey.
want=0
[ "$mode" = set ] && want=1
tmp="$(mktemp "$CONF.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
# shellcheck disable=SC2016
PSK="$psk" awk -v t="$sect" -v add="$want" "$AWK_KV"'
  s == t && k == "presharedkey" { next }
  { print }
  add && s == t && k == "publickey" { print "PresharedKey = " ENVIRON["PSK"] }' "$CONF" >"$tmp"
# Everything but that peer's PresharedKey must stay byte for byte; the peer ends with exactly $want.
# shellcheck disable=SC2016
peer_psk() { awk -v t="$sect" -v mode="$1" "$AWK_KV"'
  s == t && k == "presharedkey" { n++; next }
  mode == "rest" { print }
  END { if (mode == "count") print n + 0 }' "$2"; }
if [ "$(peer_psk count "$tmp")" != "$want" ] || ! cmp -s <(peer_psk rest "$CONF") <(peer_psk rest "$tmp"); then
  die "правка $CONF не сошлась — файл не тронут"
fi

printf '%s\n' "$pub" >"$backup.peer"
cp "$CONF" "$backup"
chmod 0600 "$backup" "$tmp"
mv "$tmp" "$CONF"
trap - EXIT
rollback="$(undo "$pub")"

# Apply live to that one peer: other devices and the product are not touched.
if [ "$mode" = set ]; then
  wg set "$WG_IF" peer "$pub" preshared-key <(printf '%s\n' "$psk") || die "$WG_IF не принял ключ"
else
  wg set "$WG_IF" peer "$pub" preshared-key /dev/null || die "$WG_IF не снял ключ"
fi
unset psk PSK
expect=нет
[ "$mode" = set ] && expect=есть
state="$(wg show "$WG_IF" preshared-keys | awk -v k="$pub" '$1 == k { print ($2 == "(none)") ? "нет" : "есть" }')" ||
  die "$CONF записан, но живой $WG_IF не прочитан"
[ "$state" = "$expect" ] || die "$CONF записан, но в живом $WG_IF ключ: «${state:-?}», ждали «$expect»"
rm -f "$backup" "$backup.peer" || log "Не удалил $backup (в нём PrivateKey сервера) — удалите вручную."

if [ "$mode" = set ]; then
  log "PresharedKey для $ip (${pub:0:8}…) записан в $CONF и применён к живому $WG_IF; остальные устройства не тронуты."
  log "Дальше — на Mac: в туннеле под строкой PublicKey добавить PresharedKey = <ключ из буфера обмена>, затем очистите буфер. До этого туннель с Mac не соединится."
  log "Откат: этот же скрипт с --remove $ip, и на Mac удалить строку PresharedKey."
else
  log "PresharedKey для $ip (${pub:0:8}…) снят из $CONF и из живого $WG_IF. На Mac удалите строку PresharedKey."
fi
