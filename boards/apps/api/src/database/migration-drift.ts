import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SQL, sql } from "drizzle-orm";

// hash: what the file hashes to now, for the row once the gap is closed.
export type MigrationDrift = { tag: string; when: number; hash: string };

type Journal = { entries: Array<{ tag: string; when: number }> };
type Executor = {
  execute: (query: SQL) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

// The hash that drizzle-orm/migrator (readMigrationFiles) stores for a file.
const fileHash = (path: string) =>
  createHash("sha256").update(readFileSync(path).toString()).digest("hex");

// TB-64. Drizzle runs a migration once and never reads an applied file again.
// A file that grew after a dev server in watch mode applied it (dev base 0069,
// docs/impl/impl-r023-history.md) leaves the database without its tail, and
// nothing says so. drizzle.__drizzle_migrations keeps the hash of every
// applied file under the journal's `when`: a different hash is such a file.
export async function findMigrationDrift(
  db: Executor,
  migrationsFolder: string,
): Promise<MigrationDrift[]> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as Journal;
  const { rows } = await db.execute(
    sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`,
  );
  const applied = new Map(
    rows.map((row) => [Number(row.created_at), String(row.hash)]),
  );
  return journal.entries.flatMap(({ tag, when }) => {
    const appliedHash = applied.get(when);
    if (appliedHash === undefined) return [];
    const hash = fileHash(join(migrationsFolder, `${tag}.sql`));
    return appliedHash === hash ? [] : [{ tag, when, hash }];
  });
}

// Runs after migrate(). Outside production a drifted migration stops the
// start with a plain error. In production it is only logged: a stand that
// applied a file before it was edited (0077 → 0078 at the split) must not go
// down on deploy for a gap that a person has to close by hand anyway.
export async function checkMigrationDrift(
  db: Executor,
  migrationsFolder: string,
  {
    production,
    logError = console.error,
  }: { production: boolean; logError?: (message: string) => void },
): Promise<MigrationDrift[]> {
  const drift = await findMigrationDrift(db, migrationsFolder);
  if (drift.length === 0) return drift;
  const message = [
    `Applied migrations differ from their files: ${drift.map((entry) => entry.tag).join(", ")}.`,
    "Drizzle does not run an applied migration again, so the database lacks what changed in the file.",
    "Apply the difference by hand or recreate the database (boards/docs/impl/impl-r023-history.md, «Ловушка dev-базы»), then record the new hash:",
    ...drift.map(
      (entry) =>
        `  UPDATE drizzle.__drizzle_migrations SET hash = '${entry.hash}' WHERE created_at = ${entry.when};`,
    ),
  ].join("\n");
  if (production) {
    logError(`⚠️ ${message}`);
    return drift;
  }
  throw new Error(message);
}
