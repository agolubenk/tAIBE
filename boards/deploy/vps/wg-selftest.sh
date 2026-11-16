#!/usr/bin/env bash
# Local proof of the WireGuard scripts on Linux (Mac + Docker): a privileged
# container with real iptables, a dummy wg0 and stand-ins for wg and systemctl.
# Checks a split and a full device, a re-run that changes nothing, the
# claude-mem proxy address taken from .env, live packets from the t-boards
# network and another container network to the Mac proxy, preshared keys and MTU
# from wg-setup.sh and wg-issue.sh, the shared lock in all three scripts, wg-psk.sh
# live and its refusals, backup retention and file modes, the upgrade of a wg0
# from the first kit and a clean down. Leaves
# nothing behind.
# Usage: deploy/vps/wg-selftest.sh
set -euo pipefail

vps="$(cd "$(dirname "$0")" && pwd)"

docker run --rm --privileged -v "$vps:/kit:ro" alpine:3.20 sh -euc '
apk add -q bash coreutils iptables iproute2 flock socat >/dev/null
mkdir -p /stub
# The live peers are read back from wg0.conf, since syncconf is a no-op here.
cat >/stub/peers.awk <<"EOF"
function out() { if (pub != "") print (what == "peers") ? pub : pub "\t" (psk == "" ? "(none)" : psk); pub = ""; psk = "" }
/^\[/ { out(); peer = ($0 == "[Peer]"); next }
peer && $1 == "PublicKey" { pub = $3 }
peer && $1 == "PresharedKey" { psk = $3 }
END { out() }
EOF
cat >/stub/wg <<"EOF"
#!/bin/sh
case "$1" in
  genkey | genpsk) head -c 32 /dev/urandom | base64 ;;
  pubkey) echo "$(sha256sum | cut -c1-43)=" ;;
  show)
    case "${3:-}" in
      # /tmp/wg-lose-psk: the live interface "loses" the keys, as if wg set had not taken them.
      preshared-keys) awk -v what="$3" -f /stub/peers.awk /etc/wireguard/wg0.conf |
        { if [ -e /tmp/wg-lose-psk ]; then sed "s/\t.*/\t(none)/"; else cat; fi; } ;;
      peers) awk -v what="$3" -f /stub/peers.awk /etc/wireguard/wg0.conf ;;
      *) echo "SERVERpublicKEYserverPUBLICkeySERVERpublic0=" ;;
    esac ;;
  # The live change goes to a journal: peer and the key read from the file it was given.
  set) printf "%s %s\n" "$4" "$(cat "$6")" >>/tmp/wg-set.log ;;
  syncconf) cat >/dev/null ;;
esac
EOF
# FAKE_TS pins the backup timestamp, so two edits land in the same second.
cat >/stub/date <<"EOF"
#!/bin/sh
if [ -n "${FAKE_TS:-}" ] && [ "$1" = "+%Y%m%d-%H%M%S" ]; then echo "$FAKE_TS"; else exec /bin/date "$@"; fi
EOF
cat >/stub/wg-quick <<"EOF"
#!/bin/sh
grep -v -E "^(Address|PostUp|PostDown) = " "/etc/wireguard/$2.conf"
EOF
cat >/stub/systemctl <<"EOF"
#!/bin/sh
case "$1" in
  is-active) ip link show wg0 >/dev/null 2>&1 ;;
  start)
    # wg0 is a veth whose other end is the Mac (10.77.0.2) in its own namespace.
    ip link add wg0 type veth peer name wgmac netns mac
    ip -n mac addr add 10.77.0.2/24 dev wgmac
    ip -n mac link set wgmac up
    ip addr add 10.77.0.1/24 dev wg0
    ip link set wg0 up
    /etc/wireguard/t-boards-rules.sh up wg0 ;;
  stop)
    /etc/wireguard/t-boards-rules.sh down wg0
    ip link del wg0 ;;
esac
EOF
chmod +x /stub/*
export PATH="/stub:$PATH"
# Docker on the VPS owns DOCKER-USER; the rules must hook into it, ahead of the RETURN
# older Docker ends it with.
iptables -N DOCKER-USER
iptables -A DOCKER-USER -j RETURN
iptables -I FORWARD -j DOCKER-USER
ip netns add mac
ip -n mac link set lo up

fail() { echo "FAIL: $*"; exit 1; }
setup() { bash /kit/wg-setup.sh "$@" >/tmp/out 2>&1 || { cat /tmp/out; fail "wg-setup.sh $*"; }; }
k1=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
k2=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=

setup "$k1" mac split && cp /tmp/out /tmp/split.out
grep -q "^AllowedIPs = 10.77.0.0/24$" /tmp/split.out || fail "split profile"
grep -q "^Address = 10.77.0.2/32$" /tmp/split.out || fail "split address"
grep -q "^MTU = 1380$" /tmp/split.out || fail "split MTU"
psk_of() { grep -A3 "^# $1 (" /etc/wireguard/wg0.conf | sed -n "s/^PresharedKey = //p"; }
mac_psk="$(psk_of mac)"
[ -n "$mac_psk" ] || fail "new peer without PresharedKey"
grep -qxF "PresharedKey = $mac_psk" /tmp/split.out || fail "printed PresharedKey differs from the peer"
setup "$k2" phone full && cp /tmp/out /tmp/full.out
grep -q "^AllowedIPs = 0.0.0.0/0, ::/0$" /tmp/full.out || fail "full profile"
grep -q "^DNS = " /tmp/full.out || fail "full DNS"
grep -q "^Address = 10.77.0.3/32$" /tmp/full.out || fail "full address"
echo "ok: split 10.77.0.2, full 10.77.0.3"

snapshot() { iptables-save | grep -v -E "^(#|:)" | sed -E "s/\[[0-9]+:[0-9]+\]//"; }
before="$(snapshot)"
setup "$k2" phone full
[ "$before" = "$(snapshot)" ] || fail "re-run changed the rules"
[ "$(grep -c "^\[Peer\]" /etc/wireguard/wg0.conf)" = 2 ] || fail "re-run added a peer"
grep -q "^PresharedKey" /tmp/out && fail "re-run printed the PresharedKey again"
echo "ok: re-run changes nothing, new peers get a PresharedKey and MTU 1380"

redirects="$(iptables -t nat -S PREROUTING | grep -c REDIRECT || true)"
[ "$redirects" = 1 ] || fail "redirects: $redirects"
iptables -t nat -C PREROUTING -i wg0 -d 10.77.0.1/32 -p tcp --dport 443 -j REDIRECT --to-ports 8443 || fail "redirect not bound to the tunnel address"
chain() {
  cat <<EOF
-A TB-WG -i wg0 -o eth0 -j ACCEPT
-A TB-WG -i eth0 -o wg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A TB-WG -s 10.78.0.2/32 -d $1/32 -i br-tboards -o wg0 -p tcp -m tcp --dport $2 -m conntrack --ctstate NEW -j RETURN
-A TB-WG -o wg0 -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP
-A TB-WG -s $1/32 -d 10.78.0.2/32 -i wg0 -o br-tboards -p tcp -m tcp --sport $2 -m conntrack --ctstate ESTABLISHED -j RETURN
-A TB-WG -i wg0 -m conntrack --ctstate DNAT -j RETURN
-A TB-WG -i wg0 -j DROP
EOF
}
iptables -S TB-WG | tail -n +2 >/tmp/chain
chain 10.77.0.2 37702 | diff - /tmp/chain || fail "forwarding chain differs"
# install.sh warns while the rules disagree with .env or with the app address; its own check runs here.
mkdir -p /tmp/root
printf "CLAUDE_MEM_WORKER_HOST=10.77.0.2\nCLAUDE_MEM_WORKER_PORT=37702\n" >/tmp/root/.env
cp /kit/compose.yml /tmp/root/compose.yml
sed -n "/^app_ip()/p; /^app_bridge()/p; /^check_tunnel_rules() {/,/^}/p" /kit/install.sh >/tmp/ctr.sh
tunnel_check() { ROOT=/tmp/root bash -c ". /tmp/ctr.sh; log() { echo \"\$*\"; }; check_tunnel_rules"; }
[ -z "$(tunnel_check)" ] || fail "install.sh warns about matching rules: $(tunnel_check)"
sed -i "s/ipv4_address: 10.78.0.2$/ipv4_address: 10.78.0.3/" /tmp/root/compose.yml
tunnel_check | grep -q ВНИМАНИЕ || fail "install.sh misses rules made for another app address"
sed "s/bridge.name: br-tboards$/bridge.name: br-other/" /kit/compose.yml >/tmp/root/compose.yml
tunnel_check | grep -q ВНИМАНИЕ || fail "install.sh misses rules made for another bridge"
# Only the app service counts, not another service with a fixed address.
awk "/^  backup:/ { print \"    networks:\"; print \"      tb:\"; print \"        ipv4_address: 10.78.0.9\" } { print }" /kit/compose.yml >/tmp/root/compose.yml
[ "$(ROOT=/tmp/root bash -c ". /tmp/ctr.sh; app_ip")" = 10.78.0.2 ] || fail "install.sh takes an address that is not the app one"
cp /kit/compose.yml /tmp/root/compose.yml
sed -i "s/=37702$/=38000/" /tmp/root/.env
tunnel_check | grep -q ВНИМАНИЕ || fail "install.sh misses rules made for another memory port"
grep -q "com.docker.network.bridge.name: br-tboards$" /kit/compose.yml || fail "compose.yml bridge is not the one the rules allow"
grep -q "ipv4_address: 10.78.0.2$" /kit/compose.yml || fail "compose.yml app address is not the one the rules allow"
grep -q "subnet: 10.78.0.0/28$" /kit/compose.yml && grep -q "ip_range: 10.78.0.8/29$" /kit/compose.yml || fail "compose.yml may hand the app address to another container"
[ "$(iptables -S TB-WG-OUT | tail -n +2)" = "-A TB-WG-OUT -d 10.77.0.2/32 -o wg0 -p tcp -m tcp --dport 37702 -j DROP" ] || fail "host namespace not shut out of the proxy"
iptables -C OUTPUT -j TB-WG-OUT || fail "no OUTPUT hook"
iptables -C DOCKER-USER -j TB-WG || fail "no DOCKER-USER hook"
echo "ok: forwarding chain in order, hooked into FORWARD and DOCKER-USER"

# Live packets (OPS-19). Container networks the way Docker builds them: a
# bridge, MASQUERADE out of it, accept out and replies back in its own chain
# after DOCKER-USER. The Mac proxy and another Mac port listen in the mac
# namespace; a published port of the other network stands in for the product.
iptables -N DOCKER-FWD
iptables -A FORWARD -j DOCKER-FWD
bridge() {
  ip link add "$1" type bridge
  ip addr add "$2.1/$3" dev "$1"
  ip link set "$1" up
  iptables -t nat -A POSTROUTING -s "$2.0/$3" ! -o "$1" -j MASQUERADE
  iptables -A DOCKER-FWD -o "$1" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -A DOCKER-FWD -i "$1" ! -o "$1" -j ACCEPT
}
container() {
  ip netns add "$1"
  ip link add "v$1" type veth peer name ceth netns "$1"
  ip link set "v$1" master "$2" up
  ip -n "$1" addr add "$3/$4" dev ceth
  ip -n "$1" link set ceth up
  ip -n "$1" route add default via "${3%.*}.1"
}
bridge br-tboards 10.78.0 28
bridge br-other 172.31.0 24
container app br-tboards 10.78.0.2 28
container db br-tboards 10.78.0.9 28
container other br-other 172.31.0.2 24
iptables -P FORWARD DROP
iptables -t nat -A PREROUTING -i wg0 -d 10.77.0.1 -p tcp --dport 8080 -j DNAT --to-destination 172.31.0.2:80
iptables -A DOCKER-FWD -o br-other -d 172.31.0.2 -p tcp --dport 80 -j ACCEPT
ip netns exec mac socat TCP-LISTEN:37702,fork,reuseaddr /dev/null 2>/dev/null & l1=$!
ip netns exec mac socat TCP-LISTEN:2222,fork,reuseaddr /dev/null 2>/dev/null & l2=$!
ip netns exec other socat TCP-LISTEN:80,fork,reuseaddr /dev/null 2>/dev/null & l3=$!
sleep 1
# 0 = connected, 124 = timed out (a DROP); "refused" would mean no listener.
reach() { timeout 3 ${1:+ip netns exec "$1"} bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; }
open_() { reach "$@" || fail "${1:-host} cannot reach $2:$3"; }
dropped() { local rc=0; reach "$@" || rc=$?; [ "$rc" = 124 ] || fail "${1:-host} -> $2:$3 not dropped (rc $rc)"; }
live() {
  open_ app 10.77.0.2 37702
  dropped db 10.77.0.2 37702
  dropped other 10.77.0.2 37702
  dropped app 10.77.0.2 2222
  dropped "" 10.77.0.2 37702
  open_ mac 10.77.0.1 8080
}
live
# Docker restart puts its own jumps back on top of FORWARD; DOCKER-USER keeps ours.
iptables -D FORWARD -j DOCKER-USER && iptables -D FORWARD -j DOCKER-FWD
iptables -I FORWARD 1 -j DOCKER-FWD && iptables -I FORWARD 1 -j DOCKER-USER
live
# Boot: wg0 comes up before Docker, so there is no DOCKER-USER yet. Docker then finds the
# chain, keeps it and puts its jumps on top of FORWARD (its nat rules stay here for brevity).
/etc/wireguard/t-boards-rules.sh down wg0
iptables -D FORWARD -j DOCKER-USER && iptables -D FORWARD -j DOCKER-FWD
iptables -F DOCKER-USER && iptables -X DOCKER-USER
/etc/wireguard/t-boards-rules.sh up wg0
iptables -C DOCKER-USER -j TB-WG 2>/dev/null || fail "wg0 up before Docker: no DOCKER-USER hook"
iptables -N DOCKER-USER 2>/dev/null || true
iptables -A DOCKER-USER -j RETURN
iptables -I FORWARD 1 -j DOCKER-FWD && iptables -I FORWARD 1 -j DOCKER-USER
live
/etc/wireguard/t-boards-rules.sh down wg0
iptables -C DOCKER-USER -j RETURN 2>/dev/null || fail "down took Docker rules out of DOCKER-USER"
iptables -C DOCKER-USER -j TB-WG 2>/dev/null && fail "down left the DOCKER-USER hook"
/etc/wireguard/t-boards-rules.sh up wg0
kill $l1 $l2 $l3
ip netns del app && ip netns del db && ip netns del other && ip link del br-tboards && ip link del br-other
iptables -t nat -D PREROUTING -i wg0 -d 10.77.0.1 -p tcp --dport 8080 -j DNAT --to-destination 172.31.0.2:80
iptables -t nat -D POSTROUTING -s 10.78.0.0/28 ! -o br-tboards -j MASQUERADE
iptables -t nat -D POSTROUTING -s 172.31.0.0/24 ! -o br-other -j MASQUERADE
iptables -F DOCKER-FWD
echo "ok: only the app reaches the memory proxy (not its neighbours, other networks, the host or other Mac ports), devices still reach published ports, also after a Docker restart and when wg0 starts before Docker"

# The claude-mem proxy address comes from the app .env; a bad value falls back.
mkdir -p /opt/t-boards
printf "CLAUDE_MEM_WORKER_HOST=10.77.0.5\nCLAUDE_MEM_WORKER_PORT=38000\n" >/opt/t-boards/.env
setup "$k2" phone full
iptables -S TB-WG | tail -n +2 | diff <(chain 10.77.0.5 38000) - || fail "memory address from .env not applied"
[ "$(iptables -S TB-WG-OUT | tail -n +2)" = "-A TB-WG-OUT -d 10.77.0.5/32 -o wg0 -p tcp -m tcp --dport 38000 -j DROP" ] || fail "host rule kept the old memory address"
printf "CLAUDE_MEM_WORKER_HOST=192.168.1.2\nCLAUDE_MEM_WORKER_PORT=38000\n" >/opt/t-boards/.env
setup "$k2" phone full
iptables -S TB-WG | tail -n +2 | diff <(chain 10.77.0.2 37702) - || fail "address outside the tunnel kept"
rm -r /opt/t-boards
setup "$k2" phone full
echo "ok: claude-mem proxy address from .env, outside the tunnel falls back"

# wg-issue.sh: the server makes the keys; the same PresharedKey goes to the peer and the profile.
issue() { bash /kit/wg-issue.sh "$@" >/tmp/conf 2>/tmp/log </dev/null || { cat /tmp/log; fail "wg-issue.sh $*"; }; }
for i in 1 2 3 4 5; do : >/etc/wireguard/wg0.conf.bak-20200101-00000$i; done
grep "^PresharedKey = " /etc/wireguard/wg0.conf >/tmp/psk.before
issue tablet full
tablet_psk="$(sed -n "s/^PresharedKey = //p" /tmp/conf)"
[ -n "$tablet_psk" ] || fail "issued profile without PresharedKey"
[ "$(psk_of tablet)" = "$tablet_psk" ] || fail "issued PresharedKey differs from the peer"
grep -q "^MTU = 1380$" /tmp/conf || fail "issued profile without MTU"
grep -q "^Address = 10.77.0.4/32$" /tmp/conf || fail "issued address"
grep "^PresharedKey = " /etc/wireguard/wg0.conf | head -n "$(wc -l </tmp/psk.before)" | diff /tmp/psk.before - ||
  fail "issuing a device changed other PresharedKeys"
issue laptop split
[ "$(sed -n "s/^PresharedKey = //p" /tmp/conf)" != "$tablet_psk" ] || fail "two devices share a PresharedKey"
bash /kit/wg-issue.sh --revoke tablet >/dev/null 2>&1 </dev/null || fail "revoke tablet"
grep -qF "$tablet_psk" /etc/wireguard/wg0.conf && fail "revoked device left its PresharedKey"
[ "$(psk_of mac)" = "$mac_psk" ] || fail "revoke changed the mac PresharedKey"
backups="$(ls /etc/wireguard | grep -c "^wg0.conf.bak-" || true)"
[ "$backups" = 3 ] || fail "backups kept: $backups"
# At least one real backup is newer than the five planted ones, so the three oldest must be gone.
ls /etc/wireguard | grep -q "^wg0.conf.bak-20200101-00000[123]$" && fail "oldest backups kept"
echo "ok: wg-issue.sh PresharedKey in peer and profile, others untouched, three backups"

# Backups: a re-run that changes nothing keeps the last real state; edits within one
# second or after the clock went back keep the newest three; both scripts share one backup().
sed -n "/^backup() {/,/^}/p" /kit/wg-setup.sh >/tmp/backup.setup
sed -n "/^backup() {/,/^}/p" /kit/wg-issue.sh | diff /tmp/backup.setup - || fail "backup() differs between wg-setup.sh and wg-issue.sh"
has_backup() { for f in /etc/wireguard/wg0.conf.bak-[0-9]*; do cmp -s "$1" "$f" && return 0; done; return 1; }
cp /etc/wireguard/wg0.conf /tmp/pre
issue spare split
for i in 1 2 3; do
  export FAKE_TS=20991231-00000$i
  setup "$k2" phone full
done
has_backup /tmp/pre || fail "idle re-runs pushed out the state before the last edit"
rm -f /etc/wireguard/wg0.conf.bak-[0-9]*
n=0
for step in same1 same2 -same1 -same2 same3 -same3; do
  n=$((n + 1))
  cp /etc/wireguard/wg0.conf /tmp/state.$n
  # Five edits in one second, the sixth after the clock went back.
  export FAKE_TS=20991231-120000
  [ "$n" -lt 6 ] || export FAKE_TS=20991231-110000
  case "$step" in
    -*) bash /kit/wg-issue.sh --revoke "${step#-}" >/dev/null 2>&1 </dev/null || fail "revoke ${step#-}" ;;
    *) issue "$step" split ;;
  esac
done
unset FAKE_TS
for n in 4 5 6; do has_backup /tmp/state.$n || fail "edit $n of six lost its backup"; done
[ -e /etc/wireguard/wg0.conf.bak-20991231-120000-05 ] || fail "backups out of order: $(ls /etc/wireguard | grep bak-)"
bash /kit/wg-issue.sh --revoke spare >/dev/null 2>&1 </dev/null || fail "revoke spare"
for f in /etc/wireguard/wg0.conf /etc/wireguard/wg0.conf.bak-[0-9]*; do
  [ "$(stat -c %a "$f")" = 600 ] || fail "$f is $(stat -c %a "$f"), not 600"
done
# A hundredth copy of one second stops: -100 would sort first and be pruned at once.
mkdir /tmp/bk && echo old >/tmp/bk/wg0.conf.bak-20991231-120000-99 && echo new >/tmp/bk/wg0.conf
export FAKE_TS=20991231-120000
rc=0
CONF=/tmp/bk/wg0.conf bash -c ". /tmp/backup.setup; die() { echo \"СТОП: \$*\"; exit 1; }; backup" >/tmp/out 2>&1 || rc=$?
unset FAKE_TS
[ "$rc" = 1 ] && grep -q "дошли до -99" /tmp/out || fail "backup() went past -99 (rc $rc): $(ls /tmp/bk)"
[ "$(ls /tmp/bk | wc -l)" = 2 ] || fail "backup() at -99 changed the copies: $(ls /tmp/bk)"
echo "ok: backups keep the last real state and the newest three edits of one second, all 600, stop at the 99th"

# Each of the three scripts waits for the lock another one holds.
held() { rm -f /tmp/held; ( flock 9; sleep 3; : >/tmp/held ) 9>/etc/wireguard/wg0.conf.lock & sleep 1; }
held; setup "$k2" phone full; [ -f /tmp/held ] || fail "wg-setup.sh did not wait for the lock"
held; issue locked split; [ -f /tmp/held ] || fail "wg-issue.sh did not wait for the lock"
bash /kit/wg-issue.sh --revoke locked >/dev/null 2>&1 </dev/null || fail "revoke locked"

# wg-psk.sh changes one peer, live and in the file; the key shows up in no output.
mac_pub="$(grep -A2 "^# mac (" /etc/wireguard/wg0.conf | sed -n "s/^PublicKey = //p" || true)"
[ -n "$mac_pub" ] || fail "mac peer not found in wg0.conf"
new_psk="$(wg genpsk)"
held
printf %s "$new_psk" | bash /kit/wg-psk.sh 10.77.0.2 >/tmp/out 2>&1 || { cat /tmp/out; fail "wg-psk.sh set"; }
[ -f /tmp/held ] || fail "wg-psk.sh did not wait for the lock"
[ "$(psk_of mac)" = "$new_psk" ] || fail "wg-psk.sh did not set the mac PresharedKey"
[ "$(tail -1 /tmp/wg-set.log)" = "$mac_pub $new_psk" ] || fail "wg-psk.sh did not apply the key to the live peer"
grep -qF "$new_psk" /tmp/out && fail "wg-psk.sh printed the key"
[ "$(psk_of phone)" = "$(sed -n 2p /tmp/psk.before | sed "s/^PresharedKey = //")" ] || fail "wg-psk.sh changed another peer"
[ "$(stat -c %a /etc/wireguard/wg0.conf)" = 600 ] || fail "wg-psk.sh left wg0.conf wider than 600"
bash /kit/wg-psk.sh --remove 10.77.0.2 >/tmp/out 2>&1 </dev/null || { cat /tmp/out; fail "wg-psk.sh --remove"; }
[ -z "$(psk_of mac)" ] || fail "wg-psk.sh --remove left the PresharedKey"
[ "$(tail -1 /tmp/wg-set.log)" = "$mac_pub " ] || fail "wg-psk.sh --remove did not clear the live key"
[ ! -e /etc/wireguard/wg0.conf.bak-psk ] && [ ! -e /etc/wireguard/wg0.conf.bak-psk.peer ] || fail "wg-psk.sh left its backup"

# Refusals leave wg0.conf as it was.
cp /etc/wireguard/wg0.conf /tmp/conf.before
refused() {
  if bash /kit/wg-psk.sh "$@" >/tmp/out 2>&1; then fail "wg-psk.sh $* went through"; fi
  grep -q "СТОП" /tmp/out || fail "wg-psk.sh $*: no reason given"
  cmp -s /tmp/conf.before /etc/wireguard/wg0.conf || fail "wg-psk.sh $* changed wg0.conf"
}
refused 10.77.0.2 </dev/null
printf %s "$new_psk" | refused 10.77.0.99
printf %s "$new_psk" | refused
# A failed live check keeps the backup and the rollback; the next run will not overwrite it.
: >/tmp/wg-lose-psk
if printf %s "$new_psk" | bash /kit/wg-psk.sh 10.77.0.2 >/tmp/out 2>&1; then fail "wg-psk.sh passed a failed live check"; fi
rm /tmp/wg-lose-psk
[ -e /etc/wireguard/wg0.conf.bak-psk ] && grep -q "Откат: cp /etc/wireguard/wg0.conf.bak-psk" /tmp/out || fail "failed live check without backup and rollback"
grep -qF "$new_psk" /tmp/out && fail "wg-psk.sh printed the key on failure"
[ "$(stat -c %a /etc/wireguard/wg0.conf.bak-psk)" = 600 ] || fail "bak-psk wider than 600"
cp /etc/wireguard/wg0.conf /tmp/conf.before
printf %s "$new_psk" | refused 10.77.0.2
cmp -s /tmp/conf.before /etc/wireguard/wg0.conf.bak-psk && fail "the next run overwrote bak-psk"
# Its rollback clears the live key of that very peer: an older wg syncconf would keep it.
grep -qF "wg set wg0 peer $mac_pub preshared-key /dev/null && wg syncconf" /tmp/out || fail "leftover rollback does not clear the live key of the peer"
mv /etc/wireguard/wg0.conf.bak-psk /etc/wireguard/wg0.conf
rm /etc/wireguard/wg0.conf.bak-psk.peer
[ -z "$(psk_of mac)" ] || fail "rollback from bak-psk did not restore the mac peer"
echo "ok: wg-psk.sh waits for the lock, sets and removes one peer live, refuses bad input and keeps the backup of a failed run"

# wg0 from the first kit: redirect for any destination, rules inline.
/stub/systemctl stop
cat >/etc/wireguard/wg0.conf <<"EOF"
[Interface]
Address = 10.77.0.1/24
ListenPort = 51820
PrivateKey = SERVERprivateKEYserverPRIVATEkeySERVERpriv0=
# The edge nginx of the product owns 0.0.0.0:443, so tunnel traffic for 443
# goes to the t-boards TLS terminator on 10.77.0.1:8443.
PostUp = iptables -t nat -I PREROUTING 1 -i %i -p tcp --dport 443 -j REDIRECT --to-ports 8443
PostDown = iptables -t nat -D PREROUTING -i %i -p tcp --dport 443 -j REDIRECT --to-ports 8443

[Peer]
# mac
PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
AllowedIPs = 10.77.0.2/32
EOF
ip link add wg0 type dummy && ip addr add 10.77.0.1/24 dev wg0 && ip link set wg0 up
iptables -t nat -I PREROUTING 1 -i wg0 -p tcp --dport 443 -j REDIRECT --to-ports 8443
setup "$k2" phone full
[ "$(iptables -t nat -S PREROUTING | grep -c REDIRECT)" = 1 ] || fail "old redirect left behind"
grep -q "^PostUp = /etc/wireguard/t-boards-rules.sh up %i$" /etc/wireguard/wg0.conf || fail "conf not upgraded"
grep -q "^PostUp = iptables" /etc/wireguard/wg0.conf && fail "old PostUp kept"
[ "$(grep -c "^\[Peer\]" /etc/wireguard/wg0.conf)" = 2 ] || fail "upgrade lost a peer"
[ "$(grep -c "^PresharedKey" /etc/wireguard/wg0.conf)" = 1 ] || fail "upgrade gave the old mac peer a PresharedKey"
echo "ok: first-kit wg0 upgraded, mac kept without a new key, phone added as 10.77.0.3"

/stub/systemctl stop
left="$(iptables-save | grep -c -E "TB-WG|10\.77\.0" || true)"
[ "$left" = 0 ] || { iptables-save | grep -E "TB-WG|10\.77\.0"; fail "rules left after down: $left"; }
echo "ok: down removes every rule"
echo "wg-selftest: all checks passed"
'
