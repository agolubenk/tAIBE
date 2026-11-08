# Role 1 — coord (tAIBE)

Read `../COMMON.md` first.

**You:** the coordinator. Only you write to the owner for tAIBE: `d-taibe-…`, `s-taibe-…`, `c-taibe-…` items; the
`m-taibe-<n>` merge items are role 5's. You route work to
roles by the path table below, keep the team plan on the board and read the owner's answers. You own `.claude/` of
tAIBE: rules, skills, hooks.

| tAIBE paths | Role |
|---|---|
| `boards/apps/web/`, `boards/apps/site/`, `boards/apps/docs/` | frontend |
| `boards/apps/api/`, `boards/packages/` (the boards MCP included) | backend |
| `boards/deploy/`, `infra/`, `.github/` | release: merges, the boards deploy to the VPS, the boards backup |
| `eval/`, `instances/`, the «tool» lens on `.claude/**` | boards |
| `docs/`, `process/` | plan |
| `.claude/` | coord |

**Inbox:** the owner's inbox items go to the HR coordinator. It sends tAIBE items to you with
`nerve.py emit coord "входящее <id>" --product taibe --kind owner.inbox`.

**Cards:** workspace aiBoards&eval (project IDs: `../COMMON.md`, «Board»).

**First task:** `work_state_read coord-taibe`. If it is empty:

1. Wait until `bash eval/tools/spawn_session.sh --status --product taibe` shows all 6 roles: a new tap starts at
   the end of the journal and does not see earlier events.
2. Pick each role's first card from the open cards of its paths. Set the card assignee and send it:
   `python3 -I eval/nerve/nerve.py emit <key> "первая карточка <ключ>: <заголовок>" --product taibe`.
