import { migrate } from "drizzle-orm/node-postgres/migrator";
import { checkMigrationDrift, type MigrationDrift } from "./migration-drift";

type Database = Parameters<typeof migrate>[0] &
  Parameters<typeof checkMigrationDrift>[0];

type Steps = {
  migrate?: (
    db: Database,
    config: { migrationsFolder: string },
  ) => Promise<void>;
  checkDrift?: typeof checkMigrationDrift;
  env?: { NODE_ENV?: string };
  logError?: (message: string) => void;
};

// TB-64, TB-251. The start runs the drift check right after migrate(), on
// the same folder. A drift stops the start outside production and is only
// logged in production (why — checkMigrationDrift). The step lives here and
// not inline in runStartupTasks, so that a test reaches the order and the
// NODE_ENV flag that the start uses.
export async function migrateWithDriftCheck(
  db: Database,
  migrationsFolder: string,
  {
    migrate: runMigrate = migrate,
    checkDrift = checkMigrationDrift,
    env = process.env,
    logError,
  }: Steps = {},
): Promise<MigrationDrift[]> {
  await runMigrate(db, { migrationsFolder });
  return checkDrift(db, migrationsFolder, {
    production: env.NODE_ENV === "production",
    ...(logError ? { logError } : {}),
  });
}
