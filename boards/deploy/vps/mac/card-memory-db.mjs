// Card memory straight from claude-mem.db (TB-113; owner decision d-tb113-r040-1311 = «a», the R-040 exception).
// The worker's search is semantic: for «TB-108» it returns other cards, and it has no exact-key mode. So the proxy
// reads the database itself — read-only, a search by one exact key at a time, titles only, never the bodies.
// Nothing is written: the connection is opened with readOnly, and WAL lets it read while the worker writes.
// The key forms are the same as packages/claude-mem-reader/src/memory-keys.ts.

export const MAX_KEYS = 6;
const LATEST = 5;
// One more candidate than the count shows: 501 rows mean «more than 500».
const WINDOW = 501;
const COUNT_CAP = WINDOW - 1;
const TITLE_MAX = 120;
// node:sqlite takes milliseconds: a foreign lock fails the read after ~0.3 s instead of hanging the proxy.
const DB_TIMEOUT_MS = 300;
const REOPEN_MS = 30_000;
const FTS_COLUMNS = [
  "title",
  "subtitle",
  "narrative",
  "text",
  "facts",
  "concepts",
];
const OBSERVATION_COLUMNS = [
  "id",
  "title",
  "project",
  "created_at",
  "created_at_epoch",
];
// Primary result codes; node:sqlite may give an extended code, so the low byte is compared.
// SQLITE_ERROR (1) and SQLITE_NOTADB (26) from the schema probe: the file is not a claude-mem database we know.
const NOT_RECOGNISED = new Set([1, 26]);
// SQLITE_BUSY (5) and SQLITE_LOCKED (6).
const SQLITE_BUSY = new Set([5, 6]);
const primaryCode = (err) =>
  typeof err?.errcode === "number" ? err.errcode & 0xff : null;

const KEY_FORMS = [
  ["id", /^[a-z0-9]{24}$/],
  ["key", /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,6}$/],
  [
    "queue",
    /^(?=.{3,64}$)(?:[a-z][a-z0-9]*-)?[a-z]-[a-z0-9]+(?:-[a-z0-9]+){0,6}$/,
  ],
];

export function keyForm(key) {
  for (const [form, re] of KEY_FORMS) if (re.test(key)) return form;
  return null;
}

// URLSearchParams has already decoded the query: %22 is a quote here, «+» a space, and neither fits a key form,
// so nothing but letters, digits and hyphens reaches the FTS phrase.
export function parseKeys(searchParams) {
  for (const name of searchParams.keys()) {
    if (name !== "key") return { error: "only key parameters" };
  }
  const keys = [...new Set(searchParams.getAll("key"))];
  if (keys.length === 0 || keys.length > MAX_KEYS) {
    return { error: `1 to ${MAX_KEYS} keys` };
  }
  const parsed = [];
  for (const key of keys) {
    const matchedOn = keyForm(key);
    if (!matchedOn)
      return { error: "not a card id, card key or queue item id" };
    parsed.push({ key, matchedOn });
  }
  return { keys: parsed };
}

function clip(title) {
  if (title == null) return null;
  const chars = [...title];
  return chars.length > TITLE_MAX
    ? `${chars.slice(0, TITLE_MAX - 1).join("")}…`
    : title;
}

function columns(db, table) {
  return db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => row.name);
}

// The search joins observations_fts.rowid to observations.id. That holds only for an external-content index of
// observations keyed by id, as claude-mem declares it (checked on the live database 14.11). An index built any
// other way would join to other observations and show their titles, so it is «schema_changed» (TB-121).
const FTS_CONTENT = /\bcontent\s*=\s*['"]?observations['"]?\s*[,)]/i;
const FTS_CONTENT_ROWID = /\bcontent_rowid\s*=\s*['"]?id['"]?\s*[,)]/i;

function ftsIndexesObservations(db) {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations_fts'",
    )
    .get();
  const sql = typeof row?.sql === "string" ? row.sql : "";
  return FTS_CONTENT.test(sql) && FTS_CONTENT_ROWID.test(sql);
}

// claude-mem changes its schema between versions: anything unexpected is «schema_changed», not a wrong answer.
function schemaFits(db) {
  const mode = db.prepare("PRAGMA journal_mode").get();
  if (String(mode?.journal_mode).toLowerCase() !== "wal") return false;
  const fts = columns(db, "observations_fts");
  if (
    fts.length !== FTS_COLUMNS.length ||
    FTS_COLUMNS.some((c) => !fts.includes(c))
  ) {
    return false;
  }
  if (!ftsIndexesObservations(db)) return false;
  const observations = columns(db, "observations");
  if (OBSERVATION_COLUMNS.some((c) => !observations.includes(c))) return false;
  db.prepare(
    `SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"probe"' LIMIT 1`,
  ).all();
  db.prepare(
    `SELECT ${OBSERVATION_COLUMNS.join(", ")} FROM observations LIMIT 1`,
  ).all();
  return true;
}

// The candidates are the newest 501 matches by rowid; rowid does not grow strictly
// with time, so the 5 shown are sorted by created_at_epoch. Above 500 matches «latest» is approximate.
const CANDIDATES = `SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rowid DESC LIMIT ${WINDOW}`;

function prepare(db) {
  return {
    count: db.prepare(`SELECT count(*) AS n FROM (${CANDIDATES})`),
    latest: db.prepare(
      `SELECT o.id, o.title, o.project, o.created_at AS createdAt FROM observations o JOIN (${CANDIDATES}) c ON o.id = c.id ORDER BY o.created_at_epoch DESC LIMIT ${LATEST}`,
    ),
  };
}

const isBusy = (err) => SQLITE_BUSY.has(primaryCode(err));

export function createCardMemoryDb(
  path,
  { now = () => Date.now(), load = () => import("node:sqlite") } = {},
) {
  let db = null;
  let statements = null;
  let state = "unavailable";
  let retryAt = 0;
  let opening = null;

  function close() {
    try {
      db?.close();
    } catch {
      // already closed
    }
    db = null;
    statements = null;
  }

  async function reopen() {
    close();
    retryAt = now() + REOPEN_MS;
    let sqlite;
    try {
      sqlite = await load();
    } catch {
      return (state = "unavailable");
    }
    try {
      db = new sqlite.DatabaseSync(path, {
        readOnly: true,
        timeout: DB_TIMEOUT_MS,
      });
    } catch {
      // No file (SQLITE_CANTOPEN): try again in 30 s.
      return (state = "unavailable");
    }
    try {
      state = schemaFits(db) ? "ok" : "schema_changed";
    } catch (err) {
      // A file that is not a database (SQLITE_NOTADB) or not claude-mem's (SQLITE_ERROR) is «schema_changed».
      // A lock, or no -shm after a reboot until the worker opens the database, is «unavailable»: try again in 30 s.
      state = NOT_RECOGNISED.has(primaryCode(err))
        ? "schema_changed"
        : "unavailable";
    }
    if (state === "ok") statements = prepare(db);
    else close();
    return state;
  }

  function open() {
    opening ??= reopen().finally(() => {
      opening = null;
    });
    return opening;
  }

  function search({ key, matchedOn }) {
    const phrase = `"${key}"`;
    const n = Number(statements.count.get(phrase).n);
    const latest = statements.latest.all(phrase).map((row) => ({
      id: Number(row.id),
      title: clip(row.title),
      project: row.project,
      createdAt: row.createdAt,
    }));
    return {
      key,
      matchedOn,
      count: Math.min(n, COUNT_CAP),
      capped: n > COUNT_CAP,
      latest,
    };
  }

  // Synchronous: health and the worker routes wait while it runs. Measured on the live 2.5 GB claude-mem.db
  // (13.11, node 22.23): one key 2.5–23 ms, 6 keys 17 ms warm and 36 ms cold. At the 10 requests a second limit the
  // event loop is busy up to 170–360 ms a second; the API's 60 s cache keeps real traffic far below that.
  async function find(keys) {
    if (opening) await opening;
    if (state !== "ok" && now() >= retryAt) await open();
    if (state !== "ok") return { status: state };
    try {
      return { status: "ok", keys: keys.map(search) };
    } catch (err) {
      if (isBusy(err)) return { status: "busy" };
    }
    // A failed query (claude-mem updated under us): open again and check the schema once.
    if ((await open()) !== "ok") return { status: state };
    try {
      return { status: "ok", keys: keys.map(search) };
    } catch (err) {
      if (isBusy(err)) return { status: "busy" };
      close();
      return { status: (state = "schema_changed") };
    }
  }

  return { open, find, state: () => state };
}
