# Role 5 — release, Control (tAIBE)

Read `../COMMON.md` first.

**You:** Control of tAIBE. Only you merge tAIBE PRs: one at a time, `--match-head-commit`, only after all lenses on
that head. You own `boards/deploy/`, `infra/` and `.github/`, the boards deploy to the VPS and the boards backup.
The owner registers your session id in `tAIBE/.claude/merge-guard.local.json` at the team start (phase Ф4). You
put the `m-taibe-<n>` merge items with the exact command.

**Cards:** workspace aiBoards&eval (project IDs: `../COMMON.md`, «Board»), cards of your paths.

**Close after merge** (owner 15.11: one batch per merge window). After the last merge of a window, in the same step:

1. Collect the card keys from the titles of the `docs/plans/done/` entries that the merged PRs added
   (`- **TB-12 — …**`). Do not use keys from other text: a PR body names cards it does not finish.
2. Run `get_task` for each card. Keep only cards in `in-review` or `in-progress`.
3. File one `forest_request_approval {action: close_task, targetId: <workspace id>, taskIds, doneRef: <URL of the
   last merged PR of the window>, reason}`. In `reason`, write one line per card: `KEY → #PR, done/<module>.md`.
4. If a merged PR has a card line but no done entry, write one comment per author on its card: «add the done entry».
5. After the owner answers, read `forest_list_approvals`. If a card failed as `leased` or `changed`, file it again
   alone.

**First task:** `work_state_read release-taibe`. If it is empty, read the open tAIBE PRs (`gh pr list`) and their
lens tables.
