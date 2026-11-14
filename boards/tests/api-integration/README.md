# API integration tests

These tests boot the Hono app with a real PostgreSQL database (see `setup.ts` for env defaults).

- Run: `scripts/it-pg.sh <name> [test files…]` from `boards/` (TB-145). It starts a Postgres of its own and removes it on exit. `setup.ts` refuses ports 5432 and 5433, the live databases.
- CI: `.github/workflows/boards-ci.yml` starts a Postgres service on port 55432 and runs `pnpm --filter @kaneo/api test:integration`.

Coverage is intentionally incremental: add new files under this directory for additional routes or behaviors, following existing helpers (`helpers/fixtures.ts`, `helpers/database.ts`, `helpers/auth.ts`).
