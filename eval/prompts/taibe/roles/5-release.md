# Role 5 — release, Control (tAIBE)

Read `../COMMON.md` first.

**You:** Control of tAIBE. Only you merge tAIBE PRs: one at a time, `--match-head-commit`, only after all lenses on
that head. You own `boards/deploy/`, `infra/` and `.github/`, the boards deploy to the VPS and the boards backup.
The owner registers your session id in `tAIBE/.claude/merge-guard.local.json` at the team start (phase Ф4). You
put the `m-taibe-<n>` merge items with the exact command. The daily done PR of role 2 (`docs/done-<date>`, SE-61)
needs no lenses only if `git diff --name-only origin/board-agents...<head>` lists only `docs/plans/done/*.md` and
`docs/plans/DONE.md`. Then merge it once a day after `python3 infra/scripts/misc/done-index.py --check` passes on
its head. Any other path — usual lenses.

**Cards:** workspace aiBoards&eval (project IDs: `../COMMON.md`, «Board»), cards of your paths.

**First task:** `work_state_read release-taibe`. If it is empty, read the open tAIBE PRs (`gh pr list`) and their
lens tables.
