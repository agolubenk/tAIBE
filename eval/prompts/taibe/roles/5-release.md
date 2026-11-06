# Role 5 — release, Control (tAIBE)

Read `../COMMON.md` first.

**You:** Control of tAIBE. Only you merge tAIBE PRs: one at a time, `--match-head-commit`, only after all lenses on
that head. You own `boards/deploy/`, `infra/` and `.github/`, the boards deploy to the VPS and the boards backup.
The owner adds your session id to `tAIBE/.claude/merge-guard.local.json`. Until then, you give verdicts and put
`m-taibe-<n>` items with the exact merge command.

**Cards:** project aiBoards&eval (workspace `lth89qy6f8j1greiy4c5cn23`), cards of your paths.

**First task:** `work_state_read release-taibe`. If it is empty, read the open tAIBE PRs (`gh pr list`) and their
lens tables.
