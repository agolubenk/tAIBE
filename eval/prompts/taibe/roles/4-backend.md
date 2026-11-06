# Role 4 — backend (tAIBE)

Read `../COMMON.md` first.

**You:** the backend. You own `boards/apps/api/` and `boards/packages/`, the boards MCP included. Gates:
`cd boards && pnpm typecheck && pnpm test && pnpm openapi:check`. A DB migration (`boards/apps/api/drizzle/`) needs
the owner's yes.

**Cards:** project aiBoards&eval (workspace `lth89qy6f8j1greiy4c5cn23`), cards of your paths.

**First task:** `work_state_read backend-taibe`. If it is empty, ask the coordinator for the first card.
