#!/usr/bin/env node
// Read-only window onto the Mac claude-mem worker for t-boards on d4dev (R-040, owner decision d-tb-claude-mem = proxy-ro).
// Listens on the WireGuard address only, accepts the d4dev peer only, and forwards exactly the GET routes
// packages/claude-mem-reader/src/client.ts calls. Nothing can be written or deleted through it.
//
//   node deploy/vps/mac/memory-proxy.mjs   (or: memory-agent.sh install)
//   CMEM_PROXY_LISTEN=10.77.0.2 CMEM_PROXY_PORT=37702 CMEM_PROXY_ALLOW=10.77.0.1,10.77.0.2  (defaults)
//   CMEM_PROXY_TOKEN_FILE=~/.t-boards-memory/proxy_token  (default; memory-agent.sh token makes it)
//
// With the token file every request needs the header x-cmem-proxy-token (OPS-19): the tunnel filter ends at the
// VPS host, where root or a raw socket in the host's network gets past it. Without the file the proxy runs as before and warns once
// (rollout mode: the app learns to send the token first). The file is read at start; a new one needs a restart.
// The worker address comes from ~/.claude-mem/settings.json (CLAUDE_MEM_WORKER_HOST/PORT), as the reader does.
// While the tunnel is down the listen address does not exist: the proxy retries every 30 s instead of exiting.
//
// One route does not go to the worker: GET /api/card-memory?key=… (1–6 keys, TB-113) reads claude-mem.db itself,
// read-only, by exact key, titles only (card-memory-db.mjs). The database is CMEM_PROXY_DB, else claude-mem.db in
// CLAUDE_MEM_DATA_DIR of the settings, else ~/.claude-mem/claude-mem.db. At most 10 such requests a second.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCardMemoryDb, parseKeys } from "./card-memory-db.mjs";

const LISTEN = process.env.CMEM_PROXY_LISTEN ?? "10.77.0.2";
const PORT = Number(process.env.CMEM_PROXY_PORT ?? 37702);
const ALLOW = new Set(
  (process.env.CMEM_PROXY_ALLOW ?? "10.77.0.1,10.77.0.2")
    .split(",")
    .map((s) => s.trim()),
);
const TOKEN_FILE =
  process.env.CMEM_PROXY_TOKEN_FILE ||
  join(homedir(), ".t-boards-memory", "proxy_token");
const TOKEN_HEADER = "x-cmem-proxy-token";
const TOKEN_MIN_LENGTH = 32;
const RETRY_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const CARD_MEMORY_PATH = "/api/card-memory";
const CARD_MEMORY_PER_SECOND = 10;

// The four reads of the t-boards memory reader — and nothing else.
const ROUTES = [
  /^\/api\/health$/,
  /^\/api\/projects$/,
  /^\/api\/observations$/,
  /^\/api\/observation\/[A-Za-z0-9_-]{1,64}$/,
];

function readSettings() {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".claude-mem", "settings.json"), "utf8"),
    );
  } catch {
    return {}; // no settings file — fall back to the worker defaults
  }
}

function workerAddress(settings) {
  return {
    host: settings.CLAUDE_MEM_WORKER_HOST || "127.0.0.1",
    port: Number(settings.CLAUDE_MEM_WORKER_PORT || 37777),
  };
}

function databasePath(settings) {
  if (process.env.CMEM_PROXY_DB) return process.env.CMEM_PROXY_DB;
  const dir = settings.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
  return join(dir, "claude-mem.db");
}

// No file — rollout mode (null). A file that is there but unusable stops the proxy rather than opening it:
// launchd restarts it every 30 s and the log names the file, never its content.
function loadToken() {
  let raw;
  try {
    raw = readFileSync(TOKEN_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.error(
      `[cmem-ro-proxy] token file ${TOKEN_FILE} unreadable (${err.code}), not starting`,
    );
    process.exit(1);
  }
  const token = Buffer.from(raw.trim());
  if (token.length < TOKEN_MIN_LENGTH) {
    console.error(
      `[cmem-ro-proxy] token file ${TOKEN_FILE} holds fewer than ${TOKEN_MIN_LENGTH} characters, not starting`,
    );
    process.exit(1);
  }
  return token;
}

const settings = readSettings();
const upstream = workerAddress(settings);
const token = loadToken();
const cardMemory = createCardMemoryDb(databasePath(settings));
cardMemory.open();
if (!token) {
  console.warn(
    `[cmem-ro-proxy] no token file ${TOKEN_FILE}: allowed peers read without a token (rollout mode, OPS-19)`,
  );
}

function tokenMatches(header) {
  if (typeof header !== "string") return false;
  const got = Buffer.from(header);
  return got.length === token.length && timingSafeEqual(got, token);
}

function deny(res, status, reason) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(reason);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

// A sliding second: the d4dev API asks once per card it opens, so 10 a second is far above normal use.
const cardMemoryHits = [];
function cardMemoryLimited(now = Date.now()) {
  while (cardMemoryHits.length && now - cardMemoryHits[0] >= 1000) {
    cardMemoryHits.shift();
  }
  if (cardMemoryHits.length >= CARD_MEMORY_PER_SECOND) return true;
  cardMemoryHits.push(now);
  return false;
}

// Keys and titles are never logged here: they name the owner's work.
async function answerCardMemory(url, res) {
  if (cardMemoryLimited()) return deny(res, 429, "too many requests");
  const parsed = parseKeys(url.searchParams);
  if (parsed.error) return deny(res, 400, parsed.error);
  const result = await cardMemory.find(parsed.keys);
  if (result.status !== "ok")
    return sendJson(res, 503, { error: result.status });
  sendJson(res, 200, { keys: result.keys });
}

const server = http.createServer((req, res) => {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (!ALLOW.has(peer)) return deny(res, 403, "peer not allowed");
  // Before the method and route checks: without the token nothing about the proxy is told.
  if (token && !tokenMatches(req.headers[TOKEN_HEADER])) {
    return deny(res, 401, "");
  }
  if (req.method !== "GET") return deny(res, 405, "read-only");
  const url = new URL(req.url ?? "/", "http://proxy");
  if (url.pathname === CARD_MEMORY_PATH) {
    answerCardMemory(url, res).catch(() => {
      if (!res.headersSent) sendJson(res, 503, { error: "unavailable" });
    });
    return;
  }
  if (!ROUTES.some((re) => re.test(url.pathname)))
    return deny(res, 403, "route not allowed");

  // The worker gets its own headers only: the token stops here.
  const out = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      method: "GET",
      path: url.pathname + url.search,
      headers: { accept: "application/json" },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        "content-type": up.headers["content-type"] ?? "application/json",
        "cache-control": "no-store",
      });
      up.pipe(res);
    },
  );
  out.on("timeout", () => out.destroy(new Error("upstream timeout")));
  out.on("error", () => {
    if (!res.headersSent) deny(res, 502, "worker unavailable");
    else res.destroy();
  });
  out.end();
});

server.on("error", (err) => {
  if (err.code === "EADDRNOTAVAIL" || err.code === "EADDRINUSE") {
    console.error(
      `[cmem-ro-proxy] ${LISTEN}:${PORT} unavailable (${err.code}), retry in ${RETRY_MS / 1000}s`,
    );
    setTimeout(() => server.listen(PORT, LISTEN), RETRY_MS);
    return;
  }
  throw err;
});

server.listen(PORT, LISTEN, () => {
  const { port } = server.address();
  console.log(
    `[cmem-ro-proxy] ${LISTEN}:${port} -> ${upstream.host}:${upstream.port}, GET only, peers ${[...ALLOW].join(",")}, ${token ? "token required" : "no token"}`,
  );
});
