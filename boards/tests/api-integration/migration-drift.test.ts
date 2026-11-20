import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { sql } from "drizzle-orm";
import db from "../../apps/api/src/database";
import {
  checkMigrationDrift,
  findMigrationDrift,
} from "../../apps/api/src/database/migration-drift";
import { ensureTestDatabaseMigrated } from "./helpers/database";

// TB-64: a migration file that changed after the database applied it. The
// database stays as migrated; the drift is made in a copy of the folder.
const migrationsFolder = resolve(__dirname, "../../apps/api/drizzle");

describe("API integration: migration drift (TB-64)", () => {
  let copy: string;

  beforeAll(async () => {
    await ensureTestDatabaseMigrated();
  });

  afterEach(() => {
    if (copy) rmSync(copy, { recursive: true, force: true });
  });

  const copyFolder = () => {
    copy = mkdtempSync(join(tmpdir(), "t-boards-drizzle-"));
    cpSync(migrationsFolder, copy, { recursive: true });
    return copy;
  };
  const tagOf = (folder: string, prefix: string) => {
    const file = readdirSync(folder).find((name) => name.startsWith(prefix));
    if (!file) throw new Error(`no migration ${prefix}`);
    return file.replace(/\.sql$/, "");
  };

  it("finds no drift in a database migrated from these files", async () => {
    expect(await findMigrationDrift(db, migrationsFolder)).toEqual([]);
  });

  it("names an applied migration whose file grew afterwards", async () => {
    const folder = copyFolder();
    const tag = tagOf(folder, "0069_");
    appendFileSync(join(folder, `${tag}.sql`), "\n-- written after apply\n");

    const drift = await findMigrationDrift(db, folder);
    expect(drift.map((entry) => entry.tag)).toEqual([tag]);
  });

  it("does not count a migration that is not applied yet", async () => {
    const folder = copyFolder();
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const last = journal.entries.at(-1);
    journal.entries.push({
      ...last,
      idx: last.idx + 1,
      when: last.when + 1,
      tag: "9999_pending",
    });
    writeFileSync(journalPath, JSON.stringify(journal));
    writeFileSync(join(folder, "9999_pending.sql"), "SELECT 1;");

    expect(await findMigrationDrift(db, folder)).toEqual([]);
  });

  it("stops the start outside production and only logs in production", async () => {
    const folder = copyFolder();
    const tag = tagOf(folder, "0069_");
    appendFileSync(join(folder, `${tag}.sql`), "\n-- written after apply\n");

    await expect(
      checkMigrationDrift(db, folder, { production: false }),
    ).rejects.toThrow(tag);

    const logged: string[] = [];
    const drift = await checkMigrationDrift(db, folder, {
      production: true,
      logError: (message) => logged.push(message),
    });
    expect(drift.map((entry) => entry.tag)).toEqual([tag]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(tag);
    expect(logged[0]).toContain("Ловушка dev-базы");
  });

  it("clears the drift with the UPDATE that the error prints", async () => {
    const folder = copyFolder();
    const tag = tagOf(folder, "0069_");
    appendFileSync(join(folder, `${tag}.sql`), "\n-- written after apply\n");
    const [entry] = await findMigrationDrift(db, folder);
    if (!entry) throw new Error("no drift");
    const { rows } = await db.execute<{ hash: string }>(
      sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}`,
    );
    const original = rows[0]?.hash;
    if (!original) throw new Error("no applied row");

    try {
      const error: Error = await checkMigrationDrift(db, folder, {
        production: false,
      }).then(
        () => new Error("no error"),
        (thrown: Error) => thrown,
      );
      const update = error.message
        .split("\n")
        .find((line) => line.includes("UPDATE drizzle.__drizzle_migrations"));
      expect(update).toContain(entry.hash);
      await db.execute(sql.raw(update ?? ""));
      expect(await findMigrationDrift(db, folder)).toEqual([]);
    } finally {
      await db.execute(
        sql`UPDATE drizzle.__drizzle_migrations SET hash = ${original} WHERE created_at = ${entry.when}`,
      );
    }
    expect(await findMigrationDrift(db, migrationsFolder)).toEqual([]);
  });
});
