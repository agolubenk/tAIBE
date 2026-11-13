import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// TB-113: card memory through the Mac proxy's exact key search. One loopback
// server stands in for the memory proxy (/api/card-memory) and the owner
// queue (/api/oq/v1/db/items/<id>); nothing real is asked.
const QUEUE_ITEM = "d-tb113-mem-1311";
const ENV_KEYS = [
  "CLAUDE_MEM_WORKER_HOST",
  "CLAUDE_MEM_WORKER_PORT",
  "OQ_URL",
  "OQ_TOKEN_FILE",
  "OQ_TOKEN_NAME",
  "OQ_WORKSPACE_PRODUCTS",
] as const;

let server: Server;
let port: number;
let dir: string;
const asked: string[][] = [];
const queueAsked: string[] = [];
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/card-memory") {
      const keys = url.searchParams.getAll("key");
      asked.push(keys);
      res.end(
        JSON.stringify({
          keys: keys.map((key) => ({
            key,
            matchedOn: key.includes("-")
              ? key === QUEUE_ITEM
                ? "queue"
                : "key"
              : "id",
            count: 2,
            capped: false,
            latest: [
              {
                id: 1,
                title: `About ${key}`,
                project: "t-boards",
                createdAt: "2026-11-13T10:00:00.000Z",
              },
            ],
          })),
        }),
      );
      return;
    }
    const item = /^\/api\/oq\/v1\/db\/items\/(.+)$/.exec(url.pathname);
    if (item?.[1]) {
      const id = decodeURIComponent(item[1]);
      queueAsked.push(id);
      if (id === QUEUE_ITEM) {
        res.end(JSON.stringify({ id, data: {}, version: 1, updatedAt: 1 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), "tb-card-memory-int-"));
  writeFileSync(
    join(dir, "oq_token"),
    "synthetic-queue-token-for-tests-only\n",
  );
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // Read once, when the first request makes the process's memory finder.
  process.env.CLAUDE_MEM_WORKER_HOST = "127.0.0.1";
  process.env.CLAUDE_MEM_WORKER_PORT = String(port);
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
  await new Promise((done) => server.close(() => done(undefined)));
});

function linkQueue(workspaceId: string) {
  process.env.OQ_URL = `http://127.0.0.1:${port}`;
  process.env.OQ_TOKEN_FILE = join(dir, "oq_token");
  process.env.OQ_TOKEN_NAME = "t-boards";
  process.env.OQ_WORKSPACE_PRODUCTS = `${workspaceId}=taibe`;
}

async function numberedCard(projectId: string, slug: string, number: number) {
  await db
    .update(schema.projectTable)
    .set({ slug })
    .where(eq(schema.projectTable.id, projectId));
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId, title: "Remember me", status: "to-do", number })
    .returning();
  if (!task) throw new Error("fixture");
  return task;
}

describe("API integration: card memory (TB-113)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    asked.length = 0;
    queueAsked.length = 0;
  });

  afterEach(() => {
    delete process.env.OQ_URL;
    delete process.env.OQ_WORKSPACE_PRODUCTS;
  });

  it("searches a card by its id and board key", async () => {
    const forest = await createForest();
    const card = await numberedCard(forest.project.id, "mema", 7);

    const res = await forest.agent(`/cards/${card.id}/memory`);
    expect(res.status).toBe(200);
    expect(asked).toEqual([[card.id, "MEMA-7"]]);
    expect(res.body).toMatchObject({
      available: true,
      stale: false,
      keys: [
        { key: card.id, matchedOn: "id", count: 2 },
        {
          key: "MEMA-7",
          matchedOn: "key",
          latest: [{ title: "About MEMA-7" }],
        },
      ],
    });
  });

  it("finds the same card by its key in this workspace only", async () => {
    const forest = await createForest();
    const other = await createForest();
    const card = await numberedCard(forest.project.id, "memb", 3);

    const mine = await forest.agent("/memory?ticketKey=MEMB-3");
    expect(mine.status).toBe(200);
    expect(mine.body.keys.map((k: { key: string }) => k.key)).toEqual([
      card.id,
      "MEMB-3",
    ]);

    asked.length = 0;
    const theirs = await other.agent("/memory?ticketKey=MEMB-3");
    expect(theirs.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("searches by a queue item only when it exists and the workspace is linked", async () => {
    const forest = await createForest();

    const unlinked = await forest.agent(`/memory?queueItemId=${QUEUE_ITEM}`);
    expect(unlinked.status).toBe(503);

    linkQueue(forest.workspace.id);
    const found = await forest.agent(`/memory?queueItemId=${QUEUE_ITEM}`);
    expect(found.status).toBe(200);
    expect(found.body.keys).toMatchObject([
      { key: QUEUE_ITEM, matchedOn: "queue" },
    ]);

    const unknown = await forest.agent("/memory?queueItemId=d-unknown-1311");
    expect(unknown.status).toBe(404);
    expect(queueAsked).toEqual([QUEUE_ITEM, "d-unknown-1311"]);
    expect(asked).toEqual([[QUEUE_ITEM]]);
  });

  it("refuses none, both or a malformed key before asking anyone", async () => {
    const forest = await createForest();
    linkQueue(forest.workspace.id);
    for (const query of [
      "",
      `?ticketKey=MEMB-3&queueItemId=${QUEUE_ITEM}`,
      "?queueItemId=Not%20An%20Id",
    ]) {
      const res = await forest.agent(`/memory${query}`);
      expect(res.status, query).toBe(400);
    }
    expect(asked).toEqual([]);
    expect(queueAsked).toEqual([]);
  });
});
