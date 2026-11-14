// Pure checks of the integration DATABASE_URL, used by setup.ts (TB-145).

// The live databases on the developer's machine: backend-postgres-1 (5432,
// also the Postgres default port) and t-boards-postgres-1 (5433). Integration
// tests run on a database of their own: scripts/it-pg.sh locally, a service on
// 55432 in CI.
const LIVE_PORTS = new Set(["5432", "5433"]);

export function deriveTestDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, "");

  if (!databaseName || databaseName.endsWith("_test")) {
    return connectionString;
  }

  url.pathname = `/${databaseName}_test`;
  return url.toString();
}

export function assertTestDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Integration tests require DATABASE_URL to use a database name ending in _test (got "${databaseName}")`,
    );
  }
  const port = url.port || "5432";
  if (LIVE_PORTS.has(port)) {
    throw new Error(
      `Integration tests never use port ${port}: it belongs to a live database. Run them through scripts/it-pg.sh <name> [test files…] from boards/.`,
    );
  }
}
