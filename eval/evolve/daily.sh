#!/usr/bin/env bash
# The daily evolution run (eval/evolve/README.md «Daily run»): install | uninstall | run | status
#
#   bash eval/evolve/daily.sh install         # owner, after the merge: render the plist, load it (04:30 local)
#   bash eval/evolve/daily.sh uninstall       # unload and remove it
#   bash eval/evolve/daily.sh run [--force]   # what launchd starts: refresh the run's own worktree, then its cycle
#   bash eval/evolve/daily.sh status          # launchd state, last run, state file
#
# `run` works only in worktrees/evolve/daily (detached on a fresh origin/board-agents): no person's checkout is
# touched. The cycle (daily.py) is gateway → A/B with quality control → headless session → publish → merge; the merge
# is done here, by the owner's scheduled job, never by a Claude session (their merge-guard stays as it is).
# One run at a time (a lock in the state folder); the Mac is kept awake while it runs (caffeinate).
set -euo pipefail

LABEL="space.hrhelper.evolve-daily"
BASE="board-agents"

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

repo_of() {
  dirname "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)"
}

refresh() {  # the run's own worktree, detached on a fresh origin/$BASE
  local repo="$1" wt="$2"
  git -C "$repo" fetch --quiet origin "$BASE"
  if [[ ! -d "$wt" ]]; then
    git -C "$repo" worktree add --quiet --detach "$wt" "origin/$BASE"
  else
    git -C "$wt" checkout --quiet --force --detach "origin/$BASE"
    git -C "$wt" clean -fdq
  fi
}

run() {
  local repo="$1" wt="$2" state="$3"; shift 3
  mkdir -p "$state"
  if ! mkdir "$state/run.lock" 2>/dev/null; then
    local pid; pid="$(cat "$state/run.lock/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "evolve: a run is already going (pid $pid)"; return 0
    fi
    rm -rf "$state/run.lock"; mkdir "$state/run.lock"   # a stale lock from a run that died
  fi
  echo $$ > "$state/run.lock/pid"
  trap 'rm -rf "$state/run.lock"' EXIT
  refresh "$repo" "$wt"
  if [[ ! -f "$wt/eval/evolve/daily.py" ]]; then
    echo "evolve: origin/$BASE has no eval/evolve/daily.py yet — nothing to run"; return 0
  fi
  # The fresh copy runs, not this one: the code that judges is the code that was merged.
  if command -v caffeinate >/dev/null; then   # bash 3.2 (macOS): no empty-array expansion under set -u
    caffeinate -i python3 -I "$wt/eval/evolve/daily.py" cycle "$@"
  else
    python3 -I "$wt/eval/evolve/daily.py" cycle "$@"
  fi
}

install_job() {
  local repo="$1" wt="$2" state="$3" here="$4"
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
      -e "s#__STATE__#$state#g" -e "s#__HOME__#$HOME#g" "$here/$LABEL.plist" > "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "evolve: installed $plist — every day at 04:30, log $state/launchd.log"
}

main() {
  local here repo wt state
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(repo_of "$here")"
  wt="$repo/worktrees/evolve/daily"
  state="${EVOLVE_STATE_DIR:-$HOME/.claude/evolve}"
  case "${1:-}" in
    install) install_job "$repo" "$wt" "$state" "$here" ;;
    uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
      echo "evolve: uninstalled (the worktree $wt and the state $state stay)" ;;
    run) shift; run "$repo" "$wt" "$state" "$@" ;;
    status)
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s+(state|last exit code|runs) ' || echo "launchd: not installed"
      python3 -I "$here/daily.py" status ;;
    *) usage; return 2 ;;
  esac
}

main "$@"; exit $?
