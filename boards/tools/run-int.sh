#!/bin/zsh
# Retired 14.11 (TB-145). It took the database from boards/.env, that is the
# live t-boards-postgres-1 (5433), and from the main checkout's .env in a
# worktree without one. Integration tests run only through scripts/it-pg.sh,
# which starts a Postgres of its own and removes it on exit. The file stays so
# that old commands stop with this pointer; the former body is in git history.
echo "run-int: retired (TB-145), it pointed at the live board database." >&2
echo "run-int: from boards/ run: scripts/it-pg.sh <name> [test files…]" >&2
exit 2
