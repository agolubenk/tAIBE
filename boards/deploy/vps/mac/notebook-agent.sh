#!/bin/sh
# Mac side of the t-boards notebook: the embedding worker (always on, local
# Ollama, one request at a time) and the document sync: once a day at 04:17
# and on demand (owner, d-notebook-sync-0411), never on load or login:
#   launchctl kickstart gui/$(id -u)/space.hrhelper.t-boards-notebook-sync
#   notebook-agent.sh config <workspaceId> [repoRoot] [baseUrl] — write config.json
#   notebook-agent.sh key     — read the workspace API key from stdin (pbpaste | …)
#   notebook-agent.sh check   — one sync dry run and one worker round, in the foreground
#   notebook-agent.sh install — install both LaunchAgents
#   notebook-agent.sh remove  — unload and delete them (config and key stay)
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
home="$HOME/.t-boards-notebook"
agents="$HOME/Library/LaunchAgents"
worker_label="space.hrhelper.t-boards-notebook-worker"
sync_label="space.hrhelper.t-boards-notebook-sync"

need_setup() {
  if [ ! -f "$home/config.json" ] || [ ! -s "$home/api_key" ]; then
    echo "сначала: $0 config <workspaceId> и $0 key" >&2
    exit 1
  fi
}

# Copies, not links: a branch switch in the checkout must not swap the code
# a LaunchAgent runs.
copy_scripts() {
  for f in notebook-client.mjs notebook-worker.mjs notebook-sync.mjs; do
    cp "$here/$f" "$home/$f"
  done
}

write_plist() { # label script keepalive|daily log
  if [ "$3" = keepalive ]; then
    schedule="<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>RunAtLoad</key><true/>"
  else
    # Off the hour, at night; a missed run (Mac asleep) happens on wake.
    schedule="<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict><key>RunAtLoad</key><false/>"
  fi
  cat >"$agents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$home/$2</string></array>
  $schedule
  <key>StandardOutPath</key><string>$home/$4</string>
  <key>StandardErrorPath</key><string>$home/$4</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  config)
    [ -n "${2:-}" ] || {
      echo "usage: $0 config <workspaceId> [repoRoot] [baseUrl]" >&2
      exit 2
    }
    repo="${3:-$(cd "$here/../../../../.." && pwd)}"
    base="${4:-https://d4dev.admin.hrhelper.space}"
    git_bin="$(command -v git)"
    mkdir -p "$home"
    chmod 700 "$home"
    WS="$2" REPO="$repo" BASE="$base" GIT="$git_bin" node -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({ workspaceId: e.WS, repoRoot: e.REPO,
        baseUrl: e.BASE, ollamaUrl: "http://127.0.0.1:11434", git: e.GIT }, null, 2) + "\n");
    ' >"$home/config.json"
    echo "config: $home/config.json (repo $repo, $base)"
    ;;
  key)
    mkdir -p "$home"
    chmod 700 "$home"
    umask 077
    tr -d '\r\n' >"$home/api_key.tmp"
    [ -s "$home/api_key.tmp" ] || {
      rm -f "$home/api_key.tmp"
      echo "ключ пуст: pbpaste | $0 key" >&2
      exit 1
    }
    mv "$home/api_key.tmp" "$home/api_key"
    echo "ключ записан: $home/api_key (0600)"
    ;;
  check)
    need_setup
    copy_scripts
    node "$home/notebook-sync.mjs" --dry-run
    node "$home/notebook-worker.mjs" --once
    ;;
  install)
    need_setup
    node="$(command -v node)"
    copy_scripts
    mkdir -p "$agents"
    write_plist "$worker_label" notebook-worker.mjs keepalive worker.log
    write_plist "$sync_label" notebook-sync.mjs daily sync.log
    for label in "$worker_label" "$sync_label"; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$agents/$label.plist"
    done
    sleep 5
    tail -2 "$home/worker.log" "$home/sync.log" 2>&1 || true
    ;;
  remove)
    for label in "$worker_label" "$sync_label"; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      rm -f "$agents/$label.plist"
    done
    echo "LaunchAgents удалены; настройки и ключ на месте: $home"
    ;;
  *)
    echo "usage: $0 config|key|check|install|remove" >&2
    exit 2
    ;;
esac
