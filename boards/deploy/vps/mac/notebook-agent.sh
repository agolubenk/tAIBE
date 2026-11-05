#!/bin/sh
# Mac side of the t-boards notebook: the embedding worker (always on, local
# Ollama, one request at a time) and the document sync (once a day at 04:17 —
# owner, 04.11: daily or on request).
#   notebook-agent.sh config <workspaceId> [repoRoot] [baseUrl] — write config.json
#   notebook-agent.sh key     — read the workspace API key from stdin (pbpaste | …)
#   notebook-agent.sh workspaces <id>… — the notebooks the one worker embeds for
#   notebook-agent.sh check   — one sync dry run and one worker round, in the foreground
#   notebook-agent.sh sync    — run the installed sync now
#   notebook-agent.sh install — install the LaunchAgents (worker and sync; sync only in a second home)
#   notebook-agent.sh remove  — unload and delete them (config and key stay)
# One repo per product notebook: a second product gets its own home
# (T_BOARDS_NOTEBOOK_HOME=~/.t-boards-notebook-<name>) with only a sync agent,
# at 04:47; the worker in ~/.t-boards-notebook lists its workspace.
set -eu
# Byte ranges in the name check: under a UTF-8 locale [a-z] also lets "Hr" in.
LC_ALL=C
export LC_ALL

here="$(cd "$(dirname "$0")" && pwd)"
default_home="$HOME/.t-boards-notebook"
home="${T_BOARDS_NOTEBOOK_HOME:-$default_home}"
agents="$HOME/Library/LaunchAgents"
worker_label="space.hrhelper.t-boards-notebook-worker"
sync_label="space.hrhelper.t-boards-notebook-sync"
sync_minute=17
if [ "$home" != "$default_home" ]; then
  # Directly in $HOME and named after the product: the name is the label
  # suffix, so two homes can never share one plist.
  folder="$(basename "$home")"
  name="${folder#.t-boards-notebook-}"
  case "$name" in
    "$folder" | "" | *[!a-z0-9-]*) name="" ;;
  esac
  if [ -z "$name" ] || [ "$(dirname "$home")" != "$HOME" ]; then
    echo "T_BOARDS_NOTEBOOK_HOME: нужен ~/.t-boards-notebook-<имя> (a-z, 0-9, -)" >&2
    exit 2
  fi
  sync_label="$sync_label-$name"
  sync_minute=47
fi

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
    schedule="<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>$sync_minute</integer></dict><key>RunAtLoad</key><false/>"
  fi
  # The home is the env of every run: a second product's sync must not read
  # the default config.
  cat >"$agents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$home/$2</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>T_BOARDS_NOTEBOOK_HOME</key><string>$home</string></dict>
  $schedule
  <key>StandardOutPath</key><string>$home/$4</string>
  <key>StandardErrorPath</key><string>$home/$4</string>
</dict>
</plist>
EOF
}

# bootout returns before launchd lets go of a running KeepAlive job, and a
# bootstrap right after it fails with "Bootstrap failed: 5: Input/output
# error" — the old worker is gone and the new one never starts (05.11).
# Wait until the label is gone (≤ 10 s), then load; one retry after 2 s.
reload_agent() { # label
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$1" 2>/dev/null || true
  waited=0
  while launchctl print "$domain/$1" >/dev/null 2>&1 && [ "$waited" -lt 20 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  launchctl bootstrap "$domain" "$agents/$1.plist" 2>/dev/null || {
    sleep 2
    launchctl bootstrap "$domain" "$agents/$1.plist"
  }
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
    # Merged into the existing file: workspaceIds, extraRoots and evalRefs
    # set earlier survive a change of workspace or repo.
    WS="$2" REPO="$repo" BASE="$base" GIT="$git_bin" FILE="$home/config.json" node -e '
      const fs = require("fs");
      const e = process.env;
      let old = {};
      try { old = JSON.parse(fs.readFileSync(e.FILE, "utf8")); } catch {}
      const config = { ollamaUrl: "http://127.0.0.1:11434", ...old,
        workspaceId: e.WS, repoRoot: e.REPO, baseUrl: e.BASE, git: e.GIT };
      fs.writeFileSync(e.FILE, JSON.stringify(config, null, 2) + "\n");
      const kept = ["workspaceIds", "extraRoots", "evalRefs"].filter((k) => k in old);
      if (kept.length) console.log("сохранено из прежнего config.json: " + kept.join(", "));
    '
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
  workspaces)
    if [ "$home" != "$default_home" ]; then
      echo "воркер один на Mac и читает только $default_home" >&2
      exit 2
    fi
    need_setup
    shift
    CONFIG="$home/config.json" node -e '
      const fs = require("fs");
      const file = process.env.CONFIG;
      const ids = [...new Set(process.argv.slice(1).filter(Boolean))];
      if (!ids.length) {
        console.error("usage: notebook-agent.sh workspaces <workspaceId>…");
        process.exit(2);
      }
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!ids.includes(config.workspaceId)) {
        console.error("внимание: в списке нет " + config.workspaceId + " — блокнота синка этого дома");
      }
      config.workspaceIds = ids;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
      console.log("воркер обслуживает: " + ids.join(", "));
    ' "$@"
    # The worker reads the list at start: restart it if it runs.
    if launchctl print "gui/$(id -u)/$worker_label" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/$worker_label"
      echo "воркер перезапущен"
    fi
    ;;
  check)
    need_setup
    copy_scripts
    node "$home/notebook-sync.mjs" --dry-run
    # A second worker next to the running one would send Ollama two calls.
    if [ "$home" != "$default_home" ]; then
      :
    elif launchctl print "gui/$(id -u)/$worker_label" >/dev/null 2>&1; then
      echo "воркер уже работает (LaunchAgent) — пробный раунд пропущен, лог: $home/worker.log"
    else
      node "$home/notebook-worker.mjs" --once
    fi
    ;;
  sync)
    # On request, through the agent: its environment and its log.
    need_setup
    launchctl kickstart "gui/$(id -u)/$sync_label"
    echo "синк запущен, лог: $home/sync.log"
    ;;
  install)
    need_setup
    node="$(command -v node)"
    copy_scripts
    mkdir -p "$agents"
    labels="$sync_label"
    if [ "$home" = "$default_home" ]; then
      write_plist "$worker_label" notebook-worker.mjs keepalive worker.log
      labels="$worker_label $sync_label"
    fi
    write_plist "$sync_label" notebook-sync.mjs daily sync.log
    for label in $labels; do
      reload_agent "$label"
    done
    echo "синк: каждый день в 04:$sync_minute (пропущенный — при пробуждении), сейчас: T_BOARDS_NOTEBOOK_HOME=$home $0 sync"
    if [ "$home" = "$default_home" ]; then
      sleep 5
      tail -2 "$home/worker.log" 2>&1 || true
    fi
    ;;
  remove)
    labels="$sync_label"
    if [ "$home" = "$default_home" ]; then
      labels="$worker_label $sync_label"
      echo "снимается и воркер — он обслуживает блокноты всех продуктов этого Mac"
    fi
    for label in $labels; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      rm -f "$agents/$label.plist"
    done
    echo "LaunchAgents удалены; настройки и ключ на месте: $home"
    ;;
  *)
    echo "usage: $0 config|key|workspaces|check|sync|install|remove" >&2
    exit 2
    ;;
esac
