#!/bin/sh
# Mac side of t-boards memory: the read-only proxy that lets d4dev read the
# Mac's claude-mem through the tunnel (R-040, d-tb-claude-mem = proxy-ro).
#   memory-agent.sh token   — make the proxy token once (OPS-19); never printed
#   memory-agent.sh install — install the LaunchAgent (always on, restarts itself)
#   memory-agent.sh check   — no token 401, token 200, POST refused
#   memory-agent.sh remove  — unload and delete the LaunchAgent
# Rollout: token, memory-token-push.sh <vps>, deploy the app, then install
# again so the proxy starts requiring it (README «Memory proxy token»).
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
home="$HOME/.t-boards-memory"
label="space.hrhelper.t-boards-memory-proxy"
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/t-boards-memory-proxy.log"
url="http://${CMEM_PROXY_LISTEN:-10.77.0.2}:${CMEM_PROXY_PORT:-37702}"
token_file="${CMEM_PROXY_TOKEN_FILE:-$home/proxy_token}"

code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$@" || true; }
# The header reaches curl through stdin, so the token stays out of argv and the output.
with_token() { sed 's/^/x-cmem-proxy-token: /' "$token_file" | code -H @- "$@"; }

check() {
  if [ ! -s "$token_file" ]; then
    health=$(code "$url/api/health")
    post=$(code -X POST "$url/api/observations")
    echo "память: токена нет ($token_file), режим раскатки; GET health $health (ждём 200), POST $post (ждём 405)"
    [ "$health" = 200 ] && [ "$post" = 405 ]
    return
  fi
  bare=$(code "$url/api/health")
  health=$(with_token "$url/api/health")
  post=$(with_token -X POST "$url/api/observations")
  echo "память: GET health без токена $bare (ждём 401), с токеном $health (ждём 200), POST $post (ждём 405)"
  if [ "$bare" = 200 ]; then
    echo "прокси ещё без токена: memory-agent.sh install" >&2
  fi
  [ "$bare" = 401 ] && [ "$health" = 200 ] && [ "$post" = 405 ]
}

case "${1:-}" in
  token)
    if [ -s "$token_file" ]; then
      echo "токен уже есть: $token_file (новый — удалить файл и повторить)"
      exit 0
    fi
    dir=$(dirname "$token_file")
    mkdir -p "$dir"
    chmod 700 "$dir"
    tmp="$token_file.new.$$"
    # 32 random bytes, base64url without padding: 43 characters, straight into the file.
    (
      umask 077
      head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$tmp"
    )
    chmod 600 "$tmp"
    if [ "$(wc -c <"$tmp" | tr -d ' ')" != 43 ]; then
      rm -f "$tmp"
      echo "токен не получился" >&2
      exit 1
    fi
    mv "$tmp" "$token_file"
    echo "токен создан: $token_file (600). Дальше: memory-token-push.sh <vps>"
    ;;
  install)
    # launchd starts with a bare PATH: pin the node this shell finds.
    node=$(command -v node) || {
      echo "нет node в PATH" >&2
      exit 1
    }
    mkdir -p "$home" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    # A copy, not a link: a branch switch must not swap the code launchd runs.
    cp "$here/memory-proxy.mjs" "$here/card-memory-db.mjs" "$home/"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$home/memory-proxy.mjs</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>CMEM_PROXY_TOKEN_FILE</key><string>$token_file</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    sleep 2
    tail -1 "$log" 2>&1 || true
    check || echo "не отвечает: туннель поднят? лог — $log" >&2
    ;;
  check)
    check
    ;;
  remove)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "LaunchAgent удалён; копия прокси осталась в $home"
    ;;
  *)
    echo "usage: $0 token|install|check|remove" >&2
    exit 2
    ;;
esac
