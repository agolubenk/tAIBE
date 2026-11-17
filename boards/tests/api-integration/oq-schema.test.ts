import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, type DatabaseError } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ensureTestDatabaseMigrated } from "./helpers/database";

// TB-28 (a), TB-152: the owner-queue schema oq has one writer, the ops
// console (docs/specs/owner-queue-move.md §5.2, acceptance §9 item 11). The
// tests connect as the test database's superuser, as the boards app does in
// production (t_boards). Only a superuser may SET SESSION AUTHORIZATION,
// which is how a test acts as the NOLOGIN role oq_console.
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/drizzle",
);
const now = 1_794_600_000_000;
const doc = (id: string) => ({
  text: `INSERT INTO oq.docs (collection, id, data_json, version, created_at, updated_at, updated_by, product)
         VALUES ('inbox', $1, '{"b":1,"a":2}', 1, $2, $2, 'test', 'taibe')`,
  values: [id, now],
});

function connect(database?: string) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (database) url.pathname = `/${database}`;
  return new Client({ connectionString: url.toString() });
}

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (caught: DatabaseError) => caught,
  );
  if (!error) throw new Error("the statement was not refused");
  return { code: error.code, message: error.message };
}

describe("API integration: owner-queue schema oq (TB-152)", () => {
  let client: Client;

  beforeEach(async () => {
    await ensureTestDatabaseMigrated();
    client = connect();
    await client.connect();
    await client.query("SET SESSION AUTHORIZATION oq_console");
    await client.query("DELETE FROM oq.files");
    await client.query("DELETE FROM oq.events");
    await client.query("DELETE FROM oq.docs");
    await client.query("RESET SESSION AUTHORIZATION");
  });

  afterEach(async () => {
    await client.end();
  });

  it("refuses every write from the boards' superuser, also with SET ROLE oq_console", async () => {
    const refused = {
      code: "42501",
      message: expect.stringContaining(
        "only oq_console writes the owner queue",
      ),
    };
    expect(await failure(client.query(doc("w-1")))).toEqual(refused);
    expect(
      await failure(client.query("UPDATE oq.docs SET version = 2")),
    ).toEqual(refused);
    expect(await failure(client.query("DELETE FROM oq.events"))).toEqual(
      refused,
    );
    expect(await failure(client.query("TRUNCATE oq.files"))).toEqual(refused);

    await client.query("SET ROLE oq_console");
    expect(await failure(client.query(doc("w-2")))).toEqual(refused);
  });

  it("lets oq_console write with the console's own ids and time, and nothing in public", async () => {
    await client.query("SET SESSION AUTHORIZATION oq_console");

    await client.query(doc("w-1"));
    await client.query(
      "UPDATE oq.docs SET version = 2, updated_at = $1 WHERE id = 'w-1'",
      [now + 1],
    );
    // The copy inserts events with their ids; the console's own insert takes the identity.
    await client.query(
      "INSERT INTO oq.events (id, at, actor, collection, doc_id, action) VALUES (100, $1, 'copy', 'inbox', 'w-1', 'put')",
      [now],
    );
    await client.query(
      "SELECT setval(pg_get_serial_sequence('oq.events', 'id'), 100)",
    );
    const next = await client.query<{ id: string }>(
      "INSERT INTO oq.events (at, actor, collection, doc_id, action) VALUES ($1, 'console', 'inbox', 'w-1', 'patch') RETURNING id",
      [now + 1],
    );
    expect(next.rows[0]?.id).toBe("101");

    const stored = await client.query<{ data_json: string; version: number }>(
      "SELECT data_json, version FROM oq.docs WHERE id = 'w-1'",
    );
    // text, not jsonb: the raw bytes stay as written (the copy check hashes them).
    expect(stored.rows).toEqual([{ data_json: '{"b":1,"a":2}', version: 2 }]);

    expect(
      await failure(client.query('SELECT 1 FROM public."user" LIMIT 1')),
    ).toEqual({
      code: "42501",
      message: expect.stringContaining("permission denied"),
    });
  });

  it("has no column defaults: the console's write path sets time and values", async () => {
    await client.query("SET SESSION AUTHORIZATION oq_console");

    const missing = await failure(
      client.query(
        "INSERT INTO oq.docs (collection, id, data_json, version, updated_at, updated_by, product) VALUES ('inbox', 'w-3', '{}', 1, 1, 't', 'taibe')",
      ),
    );
    expect(missing.code).toBe("23502"); // not null: created_at has no default

    const defaults = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'oq' AND column_default IS NOT NULL",
    );
    expect(defaults.rows[0]?.n).toBe("0");
  });

  it("migrates a second database on the same cluster, where the roles already exist", async () => {
    const name = `${new URL(process.env.DATABASE_URL ?? "").pathname.slice(1)}_oq_rerun`;
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
    const second = connect(name);
    await second.connect();
    try {
      await migrate(drizzle(second), { migrationsFolder });
      const tables = await second.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'oq' ORDER BY table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "docs",
        "events",
        "files",
      ]);
      const guards = await second.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_trigger WHERE tgname LIKE 'oq\\_%\\_writer'",
      );
      expect(guards.rows[0]?.n).toBe("3");
    } finally {
      await second.end();
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
});
