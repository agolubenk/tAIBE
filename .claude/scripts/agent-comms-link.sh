#!/usr/bin/env bash
# One canon of agent-to-agent messages for all products on this machine (.claude/rules/00-agent-comms.md):
# the user-level link ~/.claude/rules/00-agent-comms.md points at the canon in the MAIN checkout. A worktree is not a
# target: it goes away after merge, and the role genomes exclude worktrees/**/.claude/rules/00-*.md.
#
#   agent-comms-link.sh            create or repair the link
#   agent-comms-link.sh --check    exit 1 if the link is missing, dangling or points at another file
#
# AGENT_COMMS_LINK overrides the link path (tests).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
common=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)
canon="$(dirname "$common")/.claude/rules/00-agent-comms.md"
link="${AGENT_COMMS_LINK:-$HOME/.claude/rules/00-agent-comms.md}"

check() {
  if [ ! -L "$link" ]; then
    echo "agent-comms: no link $link — run $0" >&2
    return 1
  fi
  if [ "$(readlink "$link")" != "$canon" ]; then
    echo "agent-comms: $link -> $(readlink "$link"), expected $canon — run $0" >&2
    return 1
  fi
  if [ ! -r "$link" ]; then
    echo "agent-comms: $link is dangling — pull the main checkout ($canon)" >&2
    return 1
  fi
  echo "agent-comms: ok $link -> $canon"
}

if [ "${1:-}" = "--check" ]; then
  check
  exit $?
fi

if [ ! -f "$canon" ]; then
  echo "agent-comms: no $canon — pull the main checkout first" >&2
  exit 1
fi
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "agent-comms: $link is a regular file — not overwritten; move it away and run again" >&2
  exit 1
fi
mkdir -p "$(dirname "$link")"
ln -sfn "$canon" "$link"
check
