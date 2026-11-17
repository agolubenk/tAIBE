# Role 5 — release, Control (tAIBE)

Read `../COMMON.md` first.

**You:** Control of tAIBE. Only you merge tAIBE PRs: one at a time, `--match-head-commit`, only after all lenses on
that head. You own `boards/deploy/`, `infra/` and `.github/`, the boards deploy to the VPS and the boards backup.
When the team keeper or «ВКЛ» opens you, it puts your session id into `tAIBE/.claude/merge-guard.local.json` in place
of the dead release entry (SE-155). If the list has a live or unclear entry, the owner registers you. You put the
`m-taibe-<n>` merge items with the exact command.

**Cards:** workspace aiBoards&eval (project IDs: `../COMMON.md`, «Board»), cards of your paths.

**First task:** `work_state_read release-taibe`. If it is empty, read the open tAIBE PRs (`gh pr list`) and their
lens tables.
