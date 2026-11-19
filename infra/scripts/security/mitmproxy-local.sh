#!/usr/bin/env bash
# TB-164 (TB-24 S24-1, R-075, N-006): mitmproxy only on this Mac, only on 127.0.0.1, in front of the local boards
# stand (boards/compose.local.yml: web 5173, api 1337). The owner chose mitmproxy, not hetty (d-taibe-hetty-1411,
# docs/integrations/hetty/README.md). Ops section: docs/ops/mitmproxy-local.md.
#
# usage: infra/scripts/security/mitmproxy-local.sh [start [--no-browser] | paths | remove-data]
#   start         mitmweb (proxy and web UI) on 127.0.0.1 and a separate Chrome profile through it (default)
#   --no-browser  only mitmweb; set the proxy in a client yourself
#   paths         print the data paths
#   remove-data   delete the data dir (CA, Chrome profile, saved flows) after a y/N question
#
# The data live outside git, in MITM_LOCAL_HOME (default ~/.local/state/taibe-mitmproxy). The mitmproxy CA stays
# there and is never added to the system keychain: Chrome trusts it only in its own profile, by the SPKI hash
# (--ignore-certificate-errors-spki-list). The main browser profile and the system trust store do not change.
set -euo pipefail

# A brew cask cannot be pinned (brew pin is for formulae), so the script checks the version. A new version is a PR
# that changes this line.
VERSION=12.3.1
DATA=${MITM_LOCAL_HOME:-$HOME/.local/state/taibe-mitmproxy}
PROXY_PORT=${MITM_PROXY_PORT:-8180}
WEB_PORT=${MITM_WEB_PORT:-8181}
TARGET=${MITM_TARGET_URL:-http://localhost:5173}
CHROME=${MITM_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
HOST=127.0.0.1
MITM_PID=

die() {
  echo "mitmproxy-local: $*" >&2
  exit 1
}

check_data_path() {
  case "$DATA" in
    "" | / | "$HOME" | "$HOME/") die "MITM_LOCAL_HOME must be a dir of its own, not '$DATA'" ;;
  esac
}

check_version() {
  command -v mitmweb >/dev/null 2>&1 || die "mitmweb not found. Install it: brew install --cask mitmproxy (version $VERSION)"
  local have
  have=$(mitmdump --version 2>/dev/null | awk '/^Mitmproxy:/ {print $2; exit}')
  [ "$have" = "$VERSION" ] || die "mitmproxy '$have' is installed, the script expects $VERSION (see VERSION in this file)"
}

listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

spki_hash() {
  openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
}

start() {
  local browser=1
  [ "${1:-}" = "--no-browser" ] && browser=0
  check_data_path
  check_version
  for port in "$PROXY_PORT" "$WEB_PORT"; do
    listening "$port" && die "port $port is busy (lsof -nP -iTCP:$port -sTCP:LISTEN); set MITM_PROXY_PORT / MITM_WEB_PORT"
  done
  mkdir -p "$DATA/conf" "$DATA/chrome"
  chmod 700 "$DATA"
  if ! curl -s -o /dev/null --max-time 3 "$TARGET"; then
    echo "mitmproxy-local: $TARGET does not answer; start the stand first (docs/ops/mitmproxy-local.md)" >&2
  fi

  mitmweb --listen-host "$HOST" --listen-port "$PROXY_PORT" \
    --web-host "$HOST" --web-port "$WEB_PORT" \
    --set confdir="$DATA/conf" --set web_open_browser=false &
  MITM_PID=$!
  trap 'kill "$MITM_PID" 2>/dev/null || true' EXIT INT TERM

  local waited=0
  until listening "$PROXY_PORT" && listening "$WEB_PORT"; do
    kill -0 "$MITM_PID" 2>/dev/null || die "mitmweb exited; see its output above"
    [ "$waited" -ge 30 ] && die "mitmweb did not listen on $PROXY_PORT and $WEB_PORT in 15 s"
    sleep 0.5
    waited=$((waited + 1))
  done
  echo "mitmproxy-local: proxy http://$HOST:$PROXY_PORT, web UI http://$HOST:$WEB_PORT (open it by the URL with ?token= that mitmweb prints), data $DATA"

  if [ "$browser" = 1 ]; then
    [ -x "$CHROME" ] || die "Chrome not found at '$CHROME'; set MITM_CHROME or use --no-browser"
    local ca="$DATA/conf/mitmproxy-ca-cert.pem"
    [ -s "$ca" ] || die "no CA at $ca"
    # <-loopback>: Chrome sends localhost to the proxy too (by default it bypasses the proxy for localhost).
    "$CHROME" --user-data-dir="$DATA/chrome" --no-first-run --no-default-browser-check \
      --proxy-server="http://$HOST:$PROXY_PORT" --proxy-bypass-list="<-loopback>" \
      --ignore-certificate-errors-spki-list="$(spki_hash "$ca")" "$TARGET" >/dev/null 2>&1 &
    echo "mitmproxy-local: Chrome with its own profile opens $TARGET through the proxy; Ctrl-C here stops mitmweb"
  fi
  wait "$MITM_PID"
}

remove_data() {
  check_data_path
  [ -d "$DATA" ] || {
    echo "mitmproxy-local: $DATA does not exist"
    return 0
  }
  local answer
  read -r -p "Delete $DATA (CA, Chrome profile, saved flows)? [y/N] " answer
  [ "$answer" = "y" ] || {
    echo "mitmproxy-local: nothing deleted"
    return 0
  }
  rm -rf -- "$DATA"
  echo "mitmproxy-local: $DATA deleted"
}

case "${1:-start}" in
  start) start "${2:-}" ;;
  paths) printf 'data   %s\nCA     %s\nChrome %s\n' "$DATA" "$DATA/conf/mitmproxy-ca-cert.pem" "$DATA/chrome" ;;
  remove-data) remove_data ;;
  *) die "unknown command '$1' (start [--no-browser] | paths | remove-data)" ;;
esac
