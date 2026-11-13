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
const SQLITE_ERROR = 1;
const SQLITE_BUSY = new Set([5, 6]);

const KEY_FORMS = [
  ["id", /^[a-z0-9]{24}$/],
  ["key", /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/],
  ["queue", /^(?=.{3,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){1,7}$/],
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

// The candidates are the newest 501 matches by rowid (0.1–0.2 ms at any match count); rowid does not grow strictly
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

const isBusy = (err) => SQLITE_BUSY.has(err?.errcode);

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
      state = schemaFits(db) ? "ok" : "schema_changed";
    } catch (err) {
      // No file, or no -shm after a reboot until the worker opens the database: try again in 30 s.
      state = err?.errcode === SQLITE_ERROR ? "schema_changed" : "unavailable";
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

  // Synchronous and bounded: 6 keys × ≤ 0.2 ms, so health and the worker routes are not held up.
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
