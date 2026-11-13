import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createCardMemoryDb } from "../../../deploy/vps/mac/card-memory-db.mjs";
import {
  type FakeWorker,
  makeHome,
  type RunningProxy,
  startProxy,
  startWorker,
} from "./harness";

// TB-113: the proxy's /api/card-memory reads a claude-mem.db copy — the same
// observations table and external-content FTS5 index, in WAL mode — and
// answers by exact key, titles only. The database is synthetic.
type Row = {
  title: string | null;
  narrative?: string;
  text?: string;
  project?: string;
  epoch: number;
};

const SECRET_BODY = "synthetic-body-text-never-in-an-answer";

// The connection stays open, as the worker keeps it: the -wal and -shm files
// exist while the proxy reads. The caller closes it.
// claude-mem's own declaration of the index (live claude-mem.db, 14.11).
const EXTERNAL_CONTENT = ", content='observations', content_rowid='id'";

function makeDb(
  path: string,
  rows: Row[],
  { wal = true, ftsOptions = EXTERNAL_CONTENT } = {},
) {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT,
      title TEXT, subtitle TEXT, narrative TEXT, text TEXT, facts TEXT,
      concepts TEXT, created_at TEXT, created_at_epoch INTEGER
    );
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, subtitle, narrative, text, facts, concepts${ftsOptions}
    );
  `);
  const insert = db.prepare(
    "INSERT INTO observations (project, title, narrative, text, facts, concepts, created_at, created_at_epoch) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?)",
  );
  const index = db.prepare(
    "INSERT INTO observations_fts (rowid, title, subtitle, narrative, text, facts, concepts) VALUES (?, ?, NULL, ?, ?, '[]', '[]')",
  );
  db.exec("BEGIN");
  for (const row of rows) {
    const createdAt = new Date(row.epoch).toISOString();
    const result = insert.run(
      row.project ?? "t-boards",
      row.title,
      row.narrative ?? null,
      row.text ?? null,
      createdAt,
      row.epoch,
    );
    index.run(
      Number(result.lastInsertRowid),
      row.title,
      row.narrative ?? null,
      row.text ?? null,
    );
  }
  db.exec("COMMIT");
  return db;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

describe("memory-proxy.mjs /api/card-memory", () => {
  let dir: string;
  let home: string;
  let dbPath: string;
  let worker: FakeWorker;
  let proxy: RunningProxy | undefined;
  let writer: DatabaseSync | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tb-card-memory-"));
    worker = await startWorker();
    home = makeHome(dir, worker.port);
    dbPath = join(dir, "claude-mem.db");
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    writer?.close();
    writer = undefined;
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    proxy = await startProxy(home, { CMEM_PROXY_DB: dbPath });
    return proxy;
  }

  async function ask(query: string) {
    const res = await fetch(
      `http://127.0.0.1:${proxy?.port}/api/card-memory${query}`,
    );
    // deny() answers in plain text, the route itself in JSON.
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }

  it("counts exact matches per key and shows the 5 newest titles, never the text", async () => {
    const long = `TB-108 ${"x".repeat(200)}`;
    writer = makeDb(dbPath, [
      { title: "Deploy TB-108 to d4dev", narrative: SECRET_BODY, epoch: T0 },
      {
        title: "Unrelated",
        text: `mentions TB-108 in the text`,
        epoch: T0 + DAY,
      },
      { title: "TB-1080 is another card", epoch: T0 + 2 * DAY },
      { title: "XTB-108 is another word", epoch: T0 + 3 * DAY },
      { title: long, epoch: T0 + 4 * DAY },
      {
        title: "Asked d-tb113-mem-1311",
        project: "other-product",
        epoch: T0 + 5 * DAY,
      },
      { title: null, narrative: "TB-108 without a title", epoch: T0 + 6 * DAY },
      { title: "TB-108 again", epoch: T0 + 7 * DAY },
      { title: "TB-108 more", epoch: T0 + 8 * DAY },
      // Indexed out of time order: rowid is not the order of created_at_epoch.
      { title: "TB-108 newest", epoch: T0 + 30 * DAY },
    ]);
    await start();

    const { status, body } = await ask(
      "?key=TB-108&key=d-tb113-mem-1311&key=g88se9086hag2gzm0fgjul5w",
    );
    expect(status).toBe(200);
    const [card, queue, id] = body.keys;

    expect(card).toMatchObject({
      key: "TB-108",
      matchedOn: "key",
      count: 7,
      capped: false,
    });
    expect(
      card.latest.map((line: { title: string | null }) => line.title),
    ).toEqual([
      "TB-108 newest",
      "TB-108 more",
      "TB-108 again",
      null,
      `${long.slice(0, 119)}…`,
    ]);
    expect(card.latest[0]).toEqual({
      id: 10,
      title: "TB-108 newest",
      project: "t-boards",
      createdAt: new Date(T0 + 30 * DAY).toISOString(),
    });
    expect(queue).toMatchObject({ matchedOn: "queue", count: 1 });
    expect(queue.latest[0].project).toBe("other-product");
    expect(id).toEqual({
      key: "g88se9086hag2gzm0fgjul5w",
      matchedOn: "id",
      count: 0,
      capped: false,
      latest: [],
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_BODY);
    expect(JSON.stringify(body)).not.toContain("in the text");
  });

  it("caps the count at 500 and says so", async () => {
    writer = makeDb(
      dbPath,
      Array.from({ length: 503 }, (_, i) => ({
        title: `CAP-1 note ${i}`,
        epoch: T0 + i,
      })),
    );
    await start();
    const { body } = await ask("?key=CAP-1");
    expect(body.keys[0]).toMatchObject({ count: 500, capped: true });
    expect(body.keys[0].latest).toHaveLength(5);
  });

  it("refuses anything but 1 to 6 keys of the three forms", async () => {
    writer = makeDb(dbPath, [{ title: "TB-1", epoch: T0 }]);
    await start();
    const seven = Array.from({ length: 7 }, (_, i) => `key=TB-${i + 1}`).join(
      "&",
    );
    for (const query of [
      "",
      `?${seven}`,
      "?key=free%20text",
      `?key=${encodeURIComponent('"TB-1" OR title:*')}`,
      "?key=TB-1*",
      // TB-121: a hyphenated word is not a queue id for the token holder.
      "?key=api-key",
      "?key=root-password",
      "?key=TB-1&project=t-boards",
      "?q=TB-1",
    ]) {
      const { status, body } = await ask(query);
      expect(status, query).toBe(400);
      expect(body.keys).toBeUndefined();
    }
  });

  // Control lens on 20290bce9: the queue panel's project key is one letter.
  it("finds a key of a one-letter project", async () => {
    writer = makeDb(dbPath, [{ title: "Queue panel Q-12 done", epoch: T0 }]);
    await start();
    const { status, body } = await ask("?key=Q-12");
    expect(status).toBe(200);
    expect(body.keys[0]).toMatchObject({
      key: "Q-12",
      matchedOn: "key",
      count: 1,
    });
  });

  it("answers 503 schema_changed for a file that is not a database", async () => {
    writeFileSync(dbPath, "not a database ".repeat(100));
    await start();
    expect(await ask("?key=TB-1")).toEqual({
      status: 503,
      body: { error: "schema_changed" },
    });
  });

  // WAL: a reader sees the last commit while the worker holds a write
  // transaction, so a write never makes the proxy wait or answer busy.
  it("keeps answering from the last commit while the worker writes", async () => {
    writer = makeDb(dbPath, [{ title: "TB-1 first", epoch: T0 }]);
    await start();
    writer.exec("BEGIN IMMEDIATE");
    writer.exec(
      "INSERT INTO observations (project, title, created_at, created_at_epoch) VALUES ('t-boards', 'TB-1 second', '2026-11-02T00:00:00.000Z', 1793577600000)",
    );
    writer.exec(
      "INSERT INTO observations_fts (rowid, title) VALUES (last_insert_rowid(), 'TB-1 second')",
    );
    const started = Date.now();
    const during = await ask("?key=TB-1");
    expect(Date.now() - started).toBeLessThan(250);
    expect(during.status).toBe(200);
    expect(during.body.keys[0].count).toBe(1);
    writer.exec("COMMIT");
    expect((await ask("?key=TB-1")).body.keys[0].count).toBe(2);
  });

  it("answers 503 schema_changed for a database it does not recognise", async () => {
    writer = makeDb(dbPath, [{ title: "TB-1", epoch: T0 }], { wal: false });
    await start();
    expect(await ask("?key=TB-1")).toEqual({
      status: 503,
      body: { error: "schema_changed" },
    });
  });

  // TB-121: the join of observations_fts.rowid to observations.id holds only
  // for an external-content index of observations keyed by id. Any other
  // index has rowids of its own and would show other observations' titles.
  it("calls an index not keyed by observations.id schema_changed", async () => {
    const keys = [{ key: "TB-1", matchedOn: "key" }];
    const fits = makeDb(join(dir, "fits.db"), [{ title: "TB-1", epoch: T0 }]);
    expect(
      (await createCardMemoryDb(join(dir, "fits.db")).find(keys)).status,
    ).toBe("ok");
    fits.close();
    for (const ftsOptions of [
      "",
      ", content='observations'",
      ", content='observations_old', content_rowid='id'",
      ", content='observations', content_rowid='memory_session_id'",
    ]) {
      const path = join(dir, `fts-${ftsOptions.length}.db`);
      const db = makeDb(path, [{ title: "TB-1", epoch: T0 }], { ftsOptions });
      const memory = createCardMemoryDb(path);
      expect(await memory.find(keys), ftsOptions).toEqual({
        status: "schema_changed",
      });
      db.close();
    }
  });

  it("answers 503 unavailable when there is no database, and keeps the worker routes", async () => {
    await start();
    expect(await ask("?key=TB-1")).toEqual({
      status: 503,
      body: { error: "unavailable" },
    });
    const health = await fetch(`http://127.0.0.1:${proxy?.port}/api/health`);
    expect(health.status).toBe(200);
  });

  it("allows 10 requests a second", async () => {
    writer = makeDb(dbPath, [{ title: "TB-1", epoch: T0 }]);
    await start();
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () => ask("?key=TB-1").then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it("does not write to the database and logs no key", async () => {
    writer = makeDb(dbPath, [{ title: "TB-108 secret title", epoch: T0 }]);
    const before = [statSync(dbPath).mtimeMs, statSync(`${dbPath}-wal`).size];
    await start();
    await ask("?key=TB-108");
    await ask("?key=free%20text");
    expect([statSync(dbPath).mtimeMs, statSync(`${dbPath}-wal`).size]).toEqual(
      before,
    );
    expect(proxy?.output()).not.toContain("TB-108");
    expect(proxy?.output()).not.toContain("secret title");
  });
});

// The busy branch (SQLITE_BUSY or SQLITE_LOCKED during a read) cannot be made
// with a real WAL writer, so the module gets the real node:sqlite with a lock
// switch in front of its statements.
describe("card-memory-db.mjs busy", () => {
  let dir: string;
  let writer: DatabaseSync | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-card-memory-busy-"));
  });

  afterEach(() => {
    writer?.close();
    writer = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers busy while a read hits a lock and reads again after it", async () => {
    const path = join(dir, "claude-mem.db");
    writer = makeDb(path, [{ title: "TB-1", epoch: T0 }]);
    const lock = { held: false };
    class LockableDb extends DatabaseSync {
      prepare(sql: string) {
        const statement = super.prepare(sql);
        const guard =
          <A extends unknown[], R>(read: (...args: A) => R) =>
          (...args: A): R => {
            if (lock.held) {
              // SQLITE_BUSY_RECOVERY: an extended code of SQLITE_BUSY.
              throw Object.assign(new Error("database is locked"), {
                errcode: 261,
              });
            }
            return read(...args);
          };
        return {
          get: guard(statement.get.bind(statement)),
          all: guard(statement.all.bind(statement)),
        } as unknown as ReturnType<DatabaseSync["prepare"]>;
      }
    }
    const memory = createCardMemoryDb(path, {
      load: async () => ({ DatabaseSync: LockableDb }),
    });
    const keys = [{ key: "TB-1", matchedOn: "key" }];

    expect((await memory.find(keys)).status).toBe("ok");
    lock.held = true;
    expect(await memory.find(keys)).toEqual({ status: "busy" });
    expect(memory.state()).toBe("ok");
    lock.held = false;
    const after = await memory.find(keys);
    expect(after.status).toBe("ok");
    expect(after.keys[0].count).toBe(1);
  });
});
