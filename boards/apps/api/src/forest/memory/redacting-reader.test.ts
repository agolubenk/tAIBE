import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { getMemoryReader } from "./memory-reader";

// A fake token assembled at runtime, so this file holds no key-shaped literal.
const SECRET = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const KEYS = ["CLAUDE_MEM_WORKER_HOST", "CLAUDE_MEM_WORKER_PORT"] as const;

// An observation as the worker sends it (snake_case, list fields as JSON
// strings), with the secret in every string field.
const raw = {
  id: 7,
  memory_session_id: `session ${SECRET}`,
  project: `project ${SECRET}`,
  platform_source: `source ${SECRET}`,
  type: `type ${SECRET}`,
  title: `title ${SECRET}`,
  subtitle: `subtitle ${SECRET}`,
  narrative: `narrative ${SECRET}`,
  text: `text ${SECRET}`,
  facts: JSON.stringify([`fact ${SECRET}`]),
  concepts: JSON.stringify([`concept ${SECRET}`]),
  files_read: JSON.stringify([`read/${SECRET}.md`]),
  files_modified: JSON.stringify([`modified/${SECRET}.md`]),
  prompt_number: 3,
  created_at: `created ${SECRET}`,
  created_at_epoch: 1_700_000_000_000,
};
const metadata = { tool: { args: [`arg ${SECRET}`], count: 2 }, note: SECRET };

// Every string in the value, at any depth.
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

// TB-137: the app's reader against a stand-in for the worker. Every string
// field of an observation leaves it masked; numbers keep their values.
describe("getMemoryReader masks observations (TB-137)", () => {
  const saved = new Map<string, string | undefined>();
  let worker: Server;

  beforeAll(async () => {
    worker = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/observations")) {
        res.end(
          JSON.stringify({ items: [raw], hasMore: false, offset: 0, limit: 1 }),
        );
      } else if (req.url === "/api/observation/7") {
        res.end(JSON.stringify({ ...raw, metadata: JSON.stringify(metadata) }));
      } else {
        res.end(JSON.stringify({ status: "ok" }));
      }
    });
    worker.listen(0, "127.0.0.1");
    await once(worker, "listening");
    for (const key of KEYS) saved.set(key, process.env[key]);
    process.env.CLAUDE_MEM_WORKER_HOST = "127.0.0.1";
    process.env.CLAUDE_MEM_WORKER_PORT = String(
      (worker.address() as AddressInfo).port,
    );
  });

  afterAll(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((done) => worker.close(done));
  });

  it("masks every string field of a listed observation", async () => {
    const result = await getMemoryReader().listObservations({ limit: 1 });
    const [item] = result.data.items;
    if (!item) throw new Error("no observation");

    const found = strings(item);
    expect(found.length).toBeGreaterThanOrEqual(13);
    for (const text of found) expect(text).toContain("[REDACTED:api_key]");
    expect(JSON.stringify(result.data)).not.toContain(SECRET);
    expect(item.facts).toEqual(["fact [REDACTED:api_key]"]);
    expect(item.id).toBe(7);
    expect(item.promptNumber).toBe(3);
    expect(item.createdAtEpoch).toBe(1_700_000_000_000);
  });

  it("masks every string of one observation, nested metadata too", async () => {
    const result = await getMemoryReader().getObservation(7);

    expect(JSON.stringify(result.data)).not.toContain(SECRET);
    for (const text of strings(result.data)) {
      expect(text).toContain("[REDACTED:api_key]");
    }
    expect(result.data.metadata).toEqual({
      tool: { args: ["arg [REDACTED:api_key]"], count: 2 },
      note: "[REDACTED:api_key]",
    });
  });
});

// TB-137: one point of cleaning. The app builds the claude-mem reader in one
// place, wrapped in redaction, and the memory route reads through it.
describe("the memory route reads only through the redacting reader (TB-137)", () => {
  const src = join(__dirname, "..", "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
    });

  it("builds the reader only in memory-reader.ts, under withRedaction", () => {
    const builders = sources(src)
      .filter((path) =>
        /\b(?:createClaudeMemReader|withCache)\(/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(src, path));
    expect(builders).toEqual([join("forest", "memory", "memory-reader.ts")]);

    const reader = readFileSync(join(__dirname, "memory-reader.ts"), "utf8");
    expect(reader).toMatch(/withRedaction\(\s*withCache\(/);
  });

  it("the memory route gets its reader from getMemoryReader", () => {
    const route = readFileSync(
      join(src, "forest", "routes", "memory-routes.ts"),
      "utf8",
    );
    expect(route).toMatch(/findCardMemory\(\s*getMemoryReader\(\)/);
  });
});
