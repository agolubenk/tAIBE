import { describe, expect, it } from "vite-plus/test";
import type { ForestActor } from "../actor";
import {
  assertOwnerQueueReader,
  listOwnerQueue,
  OWNER_QUEUE_PAGE,
  OwnerQueueListCache,
  readOwnerQueueDoc,
} from "./owner-queue-view";
import type {
  QueueClient,
  QueueCollection,
  QueueDoc,
  QueueEvent,
  QueueFileReader,
  QueueListOptions,
} from "./queue-client";

const doc = (
  id: string,
  updatedAt: number,
  data: Record<string, unknown>,
  product = "taibe",
): QueueDoc => ({ id, data, version: 1, updatedAt, product });

// The console's lists as the board sees them: one ETag per (collection, open),
// 304 on a matching If-None-Match. Calls are recorded for the assertions.
function fakeConsole(state: {
  items: QueueDoc[];
  checks: QueueDoc[];
  openIds: string[];
  truncated?: { total: number };
}) {
  const calls: Array<{
    collection: QueueCollection;
    open: boolean;
    ifNoneMatch?: string;
  }> = [];
  const tag = (collection: string, open: boolean) =>
    `W/"${collection}-${open}-${state.items.length}-${state.checks.length}"`;
  const client: QueueClient & QueueFileReader = {
    async get(collection, id) {
      const list = collection === "checks" ? state.checks : state.items;
      return list.find((entry) => entry.id === id) ?? null;
    },
    async put() {
      throw new Error("read only");
    },
    async patch() {
      throw new Error("read only");
    },
    async history(collection, id): Promise<QueueEvent[]> {
      return [
        { at: 1, actor: "token:x", action: `${collection}:${id}`, after: null },
      ];
    },
    async list(collection, _offset, options: QueueListOptions = {}) {
      const open = options.open === true;
      calls.push({ collection, open, ifNoneMatch: options.ifNoneMatch });
      const etag = tag(collection, open);
      if (options.ifNoneMatch === etag) {
        return {
          docs: [],
          nextOffset: null,
          truncated: false,
          etag,
          notModified: true,
        };
      }
      const source = collection === "checks" ? state.checks : state.items;
      const docs = open
        ? source.filter((entry) => state.openIds.includes(entry.id))
        : source;
      return {
        docs,
        nextOffset: null,
        truncated: Boolean(state.truncated) && !open,
        total: state.truncated?.total,
        etag,
      };
    },
    async files(itemId) {
      return [
        {
          id: "f1",
          name: `${itemId}.png`,
          kind: "image",
          size: 10,
          createdAt: "2026-11-14",
        },
      ];
    },
  };
  return { client, calls };
}

const actor = (kind: ForestActor["kind"]): ForestActor => ({
  kind,
  id: `${kind}:1`,
  name: kind,
  userId: "u1",
});

describe("owner queue reader (TB-156)", () => {
  it("lets only the owner's session read", () => {
    expect(() => assertOwnerQueueReader(actor("owner-ui"))).not.toThrow();
    for (const kind of ["agent", "member-ui"] as const) {
      expect(() => assertOwnerQueueReader(actor(kind))).toThrow(
        /owner_session_required/,
      );
    }
  });
});

describe("owner queue list (TB-156)", () => {
  const items = [
    doc("d-1", 100, {
      kind: "decision",
      title: "Old open",
      body: "x".repeat(12_000),
    }),
    doc("d-2", 300, { kind: "decision", title: "New open" }, "hr-helper"),
    doc("d-3", 200, { kind: "merge", title: "Answered", pr: 42 }),
    doc("i-4", 400, {
      kind: "inbox",
      inbox: { type: "bug", text: "Inbox text" },
    }),
  ];
  const checks = [doc("d-3", 250, { choice: "a", at: "2026-11-14T10:00:00Z" })];
  const openIds = ["d-1", "d-2", "i-4"];

  it("shows open items of both products by default, newest first, without bodies", async () => {
    const { client } = fakeConsole({ items, checks, openIds });
    const page = await listOwnerQueue(client, new OwnerQueueListCache(), {
      collection: "items",
      state: "open",
      page: 1,
    });
    expect(page.docs.map((row) => row.id)).toEqual(["i-4", "d-2", "d-1"]);
    expect(page.docs.every((row) => row.state === "open")).toBe(true);
    expect(page.docs[0]).toMatchObject({
      title: "Inbox text",
      inboxType: "bug",
    });
    expect(JSON.stringify(page)).not.toContain("xxxx");
    expect(page).toMatchObject({
      total: 3,
      pageSize: OWNER_QUEUE_PAGE,
      truncated: false,
    });
    expect(page.products).toEqual(["hr-helper", "taibe"]);
  });

  it("takes answered as all minus open, with the answer from the checks list", async () => {
    const { client } = fakeConsole({ items, checks, openIds });
    const page = await listOwnerQueue(client, new OwnerQueueListCache(), {
      collection: "items",
      state: "answered",
      page: 1,
    });
    expect(page.docs).toHaveLength(1);
    expect(page.docs[0]).toMatchObject({
      id: "d-3",
      state: "done",
      choice: "a",
      answeredAt: "2026-11-14T10:00:00Z",
      pr: 42,
    });
  });

  it("filters by product and pages by 50", async () => {
    const many = Array.from({ length: 120 }, (_, n) =>
      doc(
        `d-${n}`,
        n,
        { kind: "decision", title: `#${n}` },
        n % 2 ? "taibe" : "hr-helper",
      ),
    );
    const { client } = fakeConsole({
      items: many,
      checks: [],
      openIds: many.map((entry) => entry.id),
    });
    const page = await listOwnerQueue(client, new OwnerQueueListCache(), {
      collection: "items",
      state: "all",
      product: "taibe",
      page: 2,
    });
    expect(page.total).toBe(60);
    expect(page.docs).toHaveLength(10);
    expect(page.docs.every((row) => row.product === "taibe")).toBe(true);
    expect(page.docs[0]?.updatedAt).toBe(19);
  });

  it("takes the product from the item id: d-taibe-… comes as hr-helper from the console", async () => {
    const mixed = [
      doc("d-taibe-x", 30, { kind: "decision", title: "tAIBE" }, "hr-helper"),
      doc("s-restart-4-taibe-1211", 20, { kind: "deploy" }, "hr-helper"),
      doc("d-hr-focus-1311", 10, { kind: "decision" }, "hr-helper"),
      doc("d-1", 5, { kind: "decision" }, "hr-helper"),
    ];
    const { client } = fakeConsole({
      items: mixed,
      checks: [],
      openIds: mixed.map((entry) => entry.id),
    });
    const cache = new OwnerQueueListCache();
    const query = {
      collection: "items" as const,
      state: "all" as const,
      page: 1,
      knownProducts: ["hr-helper", "taibe"],
    };
    const taibe = await listOwnerQueue(client, cache, {
      ...query,
      product: "taibe",
    });
    expect(taibe.docs.map((row) => [row.id, row.product])).toEqual([
      ["d-taibe-x", "taibe"],
      ["s-restart-4-taibe-1211", "taibe"],
    ]);
    expect(taibe.products).toEqual(["hr-helper", "taibe"]);
    const hr = await listOwnerQueue(client, cache, {
      ...query,
      product: "hr-helper",
    });
    expect(hr.docs.map((row) => row.id)).toEqual(["d-hr-focus-1311", "d-1"]);
  });

  it("revalidates each list with its ETag and reuses the body on 304", async () => {
    const { client, calls } = fakeConsole({ items, checks, openIds });
    const cache = new OwnerQueueListCache();
    const query = {
      collection: "items" as const,
      state: "open" as const,
      page: 1,
    };
    const first = await listOwnerQueue(client, cache, query);
    const second = await listOwnerQueue(client, cache, query);
    expect(second.docs).toEqual(first.docs);
    // Three lists a request (items, open items, checks), none per row.
    expect(calls).toHaveLength(6);
    expect(
      calls.slice(0, 3).every((call) => call.ifNoneMatch === undefined),
    ).toBe(true);
    expect(
      calls.slice(3).every((call) => call.ifNoneMatch?.startsWith('W/"')),
    ).toBe(true);
  });

  it("says when the console capped the list and how big the collection is", async () => {
    const { client } = fakeConsole({
      items,
      checks,
      openIds,
      truncated: { total: 12_000 },
    });
    const page = await listOwnerQueue(client, new OwnerQueueListCache(), {
      collection: "items",
      state: "all",
      page: 1,
    });
    expect(page).toMatchObject({ truncated: true, collectionTotal: 12_000 });
  });

  it("lists checks with their own answer and no open state", async () => {
    const { client, calls } = fakeConsole({ items, checks, openIds });
    const page = await listOwnerQueue(client, new OwnerQueueListCache(), {
      collection: "checks",
      state: "open",
      page: 1,
    });
    expect(page.docs).toEqual([
      expect.objectContaining({ id: "d-3", state: null, choice: "a" }),
    ]);
    expect(calls).toEqual([
      { collection: "checks", open: false, ifNoneMatch: undefined },
    ]);
  });
});

describe("owner queue document (TB-156)", () => {
  const items = [
    doc("i-1", 1, { kind: "inbox", inbox: { type: "idea", text: "t" } }),
    doc("d-2", 2, { kind: "decision", title: "Pick" }),
  ];
  const checks = [doc("d-2", 3, { choice: "b" })];

  it("brings an item with its answer, both journals and inbox files", async () => {
    const { client } = fakeConsole({ items, checks, openIds: [] });
    const inbox = await readOwnerQueueDoc(client, "items", "i-1");
    expect(inbox.files).toEqual([expect.objectContaining({ name: "i-1.png" })]);
    const decision = await readOwnerQueueDoc(client, "items", "d-2");
    expect(decision.check?.data).toEqual({ choice: "b" });
    expect(decision.files).toEqual([]);
    expect(decision.history[0]?.action).toBe("items:d-2");
    expect(decision.checkHistory[0]?.action).toBe("checks:d-2");
  });

  it("answers 404 for a missing document", async () => {
    const { client } = fakeConsole({ items, checks, openIds: [] });
    await expect(
      readOwnerQueueDoc(client, "items", "nope"),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
