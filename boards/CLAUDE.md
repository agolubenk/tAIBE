# tAI-Boards project instructions

Name dictionary (owner, 31.10): **tAI-Boards** = this product, a fork of Kaneo (internal `@kaneo/*` scope and `KANEO_*` env names stay until the repo split). t-boards/таи-бордс/tAI-Boards all mean this codebase.

Canonical guidance: [AGENTS.md](./AGENTS.md)

Integration tests (owner, 14.11, TB-145): run them only through `scripts/it-pg.sh <name> [test files…]` from `boards/`. The script starts a Postgres container of its own on a free port and removes it on every exit. Build the workspace packages first: `pnpm -r --filter "@kaneo/api^..." build`. Never point the tests at `t-boards-postgres-1` (5433) or `backend-postgres-1` (5432), and do not start a test database container by hand. `tools/run-int.sh` is retired. CI uses its own Postgres service.

@AGENTS.md
