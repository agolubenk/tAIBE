#!/usr/bin/env bash
# The daily evolution run (eval/evolve/README.md «Daily run»): install | uninstall | run | status
#
#   bash eval/evolve/daily.sh install         # owner, after the merge: render the plist, load it (05:00 local)
#   bash eval/evolve/daily.sh uninstall       # unload and remove it
#   bash eval/evolve/daily.sh run [--force]   # what launchd starts: `daily.py nightly` (lock → refresh → cycle)
#   bash eval/evolve/daily.sh status          # launchd state, last run, state file
#
# `run` works only in worktrees/evolve/daily (detached on a fresh origin/board-agents): no person's checkout is
# touched, and a folder that is not its own worktree's top is refused before any checkout or clean. The lock, the
# refresh and the cycle are in daily.py (`nightly`): one kernel lock (flock) shared with `daily.py cycle --force`,
# handed to the fresh cycle as an open file, so no second run can start in between. The merge is done by this
# scheduled job, never by a Claude session (their merge-guard stays as it is).
set -euo pipefail

LABEL="space.hrhelper.evolve-daily"
BASE="board-agents"

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

repo_of() {
  dirname "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)"
}

own_worktree() {  # the folder is the top of its own worktree, not a folder inside someone's checkout
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$(cd "$top" && pwd -P)" == "$(cd "$1" && pwd -P)" ]]
}

refresh() {  # the run's own worktree, detached on a fresh origin/$BASE
  local repo="$1" wt="$2"
  git -C "$repo" fetch --quiet origin "$BASE"
  if [[ ! -d "$wt" ]]; then
    git -C "$repo" worktree add --quiet --detach "$wt" "origin/$BASE"
  elif own_worktree "$wt"; then
    git -C "$wt" checkout --quiet --force --detach "origin/$BASE"
    git -C "$wt" clean -fdq
  else
    echo "evolve: $wt is not its own worktree — refusing to check out or clean there" >&2
    return 1
  fi
}

install_job() {
  local repo="$1" wt="$2" state="$3"
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist" path_dirs="" dir
  refresh "$repo" "$wt"
  if [[ ! -f "$wt/eval/evolve/daily.sh" ]]; then
    echo "evolve: origin/$BASE has no eval/evolve/daily.sh — merge the PR first"; return 1
  fi
  for tool in python3 git gh claude node ollama; do   # launchd starts with a bare PATH
    dir="$(dirname "$(command -v "$tool" 2>/dev/null || echo /usr/bin/x)")"
    [[ ":$path_dirs:" == *":$dir:"* ]] || path_dirs="${path_dirs:+$path_dirs:}$dir"
  done
  mkdir -p "$state" "$(dirname "$plist")"
  sed -e "s#__DAILY_SH__#$wt/eval/evolve/daily.sh#g" -e "s#__PATH__#$path_dirs:/usr/bin:/bin:/usr/sbin:/sbin#g" \
      -e "s#__STATE__#$state#g" -e "s#__HOME__#$HOME#g" "$wt/eval/evolve/$LABEL.plist" > "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "evolve: installed $plist — every day at 05:00, log $state/launchd.log"
}

main() {
  local here repo wt state
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(repo_of "$here")"
  wt="$repo/worktrees/evolve/daily"
  state="${EVOLVE_STATE_DIR:-$HOME/.claude/evolve}"
  case "${1:-}" in
    install) install_job "$repo" "$wt" "$state" ;;
    uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
      echo "evolve: uninstalled (the worktree $wt and the state $state stay)" ;;
    run)
      shift
      if command -v caffeinate >/dev/null; then   # keep the Mac awake while it runs
        caffeinate -i python3 -I "$here/daily.py" nightly "$@"
      else
        python3 -I "$here/daily.py" nightly "$@"
      fi ;;
    status)
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s+(state|last exit code|runs) ' || echo "launchd: not installed"
      python3 -I "$here/daily.py" status ;;
    *) usage; return 2 ;;
  esac
}

main "$@"; exit $?
