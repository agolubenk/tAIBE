import { describe, expect, it } from "vite-plus/test";
import { ownerReverts } from "./plan-focus-run";
import { type PlanStore, planPass } from "./plan-pass";
import { cardUid, type RecentCard } from "./plan-types";
import {
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";

const WS = "hr-helper-lavaeon";
const config: OwnerQueueConfig = {
  url: "https://ops.test",
  tokenFile: "/dev/null",
  tokenName: "token:t-boards",
  products: new Map([["ws-lav", "hr-helper"]]),
  plan: { products: new Map([["ws-lav", "hr-helper"]]) },
};
// 09:00 Moscow.
const DAY1 = new Date("2026-11-14T06:00:00Z");
const DAY2 = new Date("2026-11-15T06:00:00Z");

// The console's version rules: PATCH merges and null removes; ifVersion must
// match; ifVersion 0 creates only.
class MemQueue {
  readonly docs = new Map<string, QueueDoc>();
  readonly writes: string[] = [];

  data(collection: QueueCollection, id: string) {
    return this.docs.get(`${collection}/${id}`)?.data ?? {};
  }

  set(collection: QueueCollection, id: string, data: Record<string, unknown>) {
    const key = `${collection}/${id}`;
    const version = (this.docs.get(key)?.version ?? 0) + 1;
    this.docs.set(key, { id, data, version, updatedAt: 0 });
  }

  private write(
    collection: QueueCollection,
    id: string,
    data: Record<string, unknown>,
    merge: boolean,
    ifVersion?: number,
  ) {
    const current = this.docs.get(`${collection}/${id}`);
    if (ifVersion === 0 && current) throw new QueueConflict("exists");
    if (ifVersion !== undefined && (current?.version ?? 0) !== ifVersion) {
      throw new QueueConflict("version");
    }
    const next: Record<string, unknown> = merge
      ? { ...current?.data, ...data }
      : { ...data };
    for (const [key, value] of Object.entries(next)) {
      if (value === null) delete next[key];
    }
    this.writes.push(`${collection}/${id}`);
    this.set(collection, id, next);
    return structuredClone(this.docs.get(`${collection}/${id}`) as QueueDoc);
  }

  client(): QueueClient {
    return {
      get: async (collection, id) => {
        const doc = this.docs.get(`${collection}/${id}`);
        return doc ? structuredClone(doc) : null;
      },
      put: async (collection, id, data, ifVersion) =>
        this.write(collection, id, data, false, ifVersion),
      patch: async (collection, id, data, ifVersion) =>
        this.write(collection, id, data, true, ifVersion),
      history: async () => [],
      list: async (collection) => ({
        docs: [...this.docs.entries()]
          .filter(([key]) => key.startsWith(`${collection}/`))
          .map(([, doc]) => structuredClone(doc)),
        nextOffset: null,
        truncated: false,
      }),
    };
  }
}

const card = (key: string, status = "to-do"): RecentCard => ({
  ws: WS,
  key,
  product: "hr-helper",
  title: `title ${key}`,
  bug: false,
  level: "P2",
  status,
  final: false,
  closedAt: null,
});
const CATALOG = [card("APP-1"), card("APP-2"), card("APP-9", "in-review")];
const entry = (key: string) => {
  const one = CATALOG.find((c) => c.key === key) as RecentCard;
  return { key, ws: WS, t: one.title, k: "task", s: "P2", st: one.status };
};

const store: PlanStore = {
  resolve: async () =>
    new Map(CATALOG.map((one) => [cardUid(one.ws, one.key), one])),
  recent: async () => [],
  named: async (_products, keys) =>
    CATALOG.filter((one) => keys.includes(one.key)),
  abandoned: async () => new Set(),
  closed: async () => new Map(),
};

function setup() {
  const queue = new MemQueue();
  const row = (id: string, data: Record<string, unknown>) =>
    queue.set("work", id, { track: "tails", who: "agent", ...data });
  row("w-n-inputs", { title: "Ваши вбросы", status: "doing", cards: [] });
  row("w-n-a", {
    title: "A",
    status: "planned",
    planStart: "2026-11-01",
    cards: [entry("APP-1")],
  });
  row("w-n-b", {
    title: "B",
    status: "planned",
    planStart: "2026-11-05",
    cards: [entry("APP-2")],
  });
  return queue;
}
const inbox = (queue: MemQueue, id: string, text: string, receivedAt: string) =>
  queue.set("items", id, {
    kind: "inbox",
    title: "вброс",
    inbox: { text, receivedAt },
  });

const run = (queue: MemQueue, now: Date, daily: boolean) =>
  planPass(
    { client: queue.client(), config, store, now: () => now },
    { hourly: false, daily },
  );
const cardsOf = (queue: MemQueue, id: string) =>
  ((queue.data("work", id).cards as { key: string }[]) ?? []).map((c) => c.key);

describe("TB-107 in the plan pass", () => {
  it("plans the inputs, asks once a day and archives yesterday's unanswered item", async () => {
    const queue = setup();
    inbox(queue, "i-1", "сделайте APP-9 и APP-1", "2026-11-13T10:00:00Z");
    expect(await run(queue, DAY1, true)).toMatchObject({
      skipped: 0,
      left: 0,
      dailyDone: true,
    });
    expect(cardsOf(queue, "w-n-inputs")).toEqual(["APP-9"]);
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      kind: "focus",
      rows: ["w-n-inputs", "w-n-a"],
      day: { item: "d-hr-focus-20261114" },
    });
    expect(queue.data("items", "d-hr-focus-20261114")).toMatchObject({
      kind: "decision",
      focus: {
        rows: ["w-n-inputs", "w-n-a"],
        prev: [],
        keys: ["APP-1", "APP-9"],
      },
    });

    queue.writes.length = 0;
    await run(queue, DAY1, true);
    expect(queue.writes).toEqual([]);

    inbox(queue, "i-2", "и APP-2", "2026-11-14T12:00:00Z");
    await run(queue, DAY2, true);
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      rows: ["w-n-inputs", "w-n-a", "w-n-b"],
      day: { item: "d-hr-focus-20261115" },
    });
    expect(queue.data("items", "d-hr-focus-20261115").focus).toMatchObject({
      prev: ["w-n-inputs", "w-n-a"],
    });
    expect(queue.data("items", "d-hr-focus-20261114").archived).toBe(true);
  });

  it("applies «вернуть» once on any run; the same inputs move nothing next day", async () => {
    const queue = setup();
    inbox(queue, "i-1", "сделайте APP-9 и APP-1", "2026-11-13T10:00:00Z");
    await run(queue, DAY1, true);
    queue.set("checks", "d-hr-focus-20261114", {
      done: true,
      choice: "revert",
      ownerAt: "2026-11-14T07:00:00.000Z",
    });
    await run(queue, new Date("2026-11-14T07:05:00Z"), false);
    expect(queue.data("work", "focus-hr-helper")).toEqual({
      kind: "focus",
      rows: [],
      at: DAY1.toISOString(),
      day: {
        date: "2026-11-14",
        moved: expect.any(Array),
        item: "d-hr-focus-20261114",
        applied: true,
      },
    });
    expect(queue.data("items", "d-hr-focus-20261114").archived).toBe(true);

    queue.writes.length = 0;
    await run(queue, new Date("2026-11-14T07:10:00Z"), false);
    await run(queue, DAY2, true);
    expect(queue.writes).toEqual([]);

    inbox(queue, "i-2", "срочно APP-2", "2026-11-14T12:00:00Z");
    await run(queue, new Date("2026-11-15T07:00:00Z"), true);
    expect(queue.data("work", "focus-hr-helper").rows).toEqual(["w-n-b"]);
    expect(queue.data("items", "d-hr-focus-20261115").kind).toBe("decision");
  });

  it("closes the hand-made day of 13.11: restores nothing, its revert still holds the inputs", async () => {
    const queue = setup();
    queue.set("work", "focus-hr-helper", {
      kind: "focus",
      rows: [],
      prev: ["w-n-inputs"],
      at: "2026-11-13T14:06:24Z",
      day: {
        date: "2026-11-13",
        moved: [
          { row: "w-n-inputs", from: 1, to: null, why: "владелец: revert" },
        ],
        item: "d-hr-focus-1311",
      },
    });
    queue.set("items", "d-hr-focus-1311", {
      kind: "decision",
      title: "План HR: фокус",
      options: [{ id: "revert", label: "Вернуть" }],
    });
    queue.set("checks", "d-hr-focus-1311", {
      done: true,
      choice: "revert",
      ownerAt: "2026-11-13T12:17:02.153Z",
    });
    inbox(queue, "i-1", "сделайте APP-1", "2026-11-13T10:00:00Z");
    await run(queue, DAY1, false);
    expect(queue.data("work", "focus-hr-helper")).toEqual({
      kind: "focus",
      rows: [],
      at: "2026-11-13T14:06:24Z",
      day: {
        date: "2026-11-13",
        moved: expect.any(Array),
        item: "d-hr-focus-1311",
        applied: true,
      },
    });
    // Not an item of this server: the pass does not archive it.
    expect(queue.data("items", "d-hr-focus-1311").archived).toBeUndefined();
    queue.writes.length = 0;
    await run(queue, new Date("2026-11-14T06:10:00Z"), true);
    expect(queue.writes.filter((id) => id.includes("focus"))).toEqual([]);
  });

  it("an agent's focus doc neither stops the owner's inputs nor chooses what «Вернуть» restores", async () => {
    const queue = setup();
    // An agent writes a fresh revert and its own order into the work doc.
    queue.set("work", "focus-hr-helper", {
      kind: "focus",
      rows: [],
      prev: ["w-n-b"],
      at: "",
      reverted: {
        at: DAY1.toISOString(),
        rows: [],
        keys: ["APP-1"],
        item: "d-hr-focus-20261114",
      },
    });
    inbox(queue, "i-1", "сделайте APP-1", "2026-11-13T10:00:00Z");
    await run(queue, DAY1, true);
    expect(queue.data("work", "focus-hr-helper").rows).toEqual([
      "w-n-inputs",
      "w-n-a",
    ]);
    expect(queue.data("items", "d-hr-focus-20261114").kind).toBe("decision");

    queue.set("work", "focus-hr-helper", {
      ...queue.data("work", "focus-hr-helper"),
      prev: ["w-n-b"],
    });
    queue.set("checks", "d-hr-focus-20261114", {
      choice: "revert",
      ownerAt: "2026-11-14T07:00:00.000Z",
    });
    await run(queue, new Date("2026-11-14T07:05:00Z"), false);
    // The item's order before the day, not the agent's prev.
    expect(queue.data("work", "focus-hr-helper").rows).toEqual([]);
  });

  it("an item changed after the owner's answer restores nothing and closes", async () => {
    const queue = setup();
    inbox(queue, "i-1", "сделайте APP-9 и APP-1", "2026-11-13T10:00:00Z");
    await run(queue, DAY1, true);
    const item = queue.docs.get("items/d-hr-focus-20261114") as QueueDoc;
    item.updatedAt = Date.parse("2026-11-14T07:01:00Z");
    queue.set("checks", "d-hr-focus-20261114", {
      choice: "revert",
      ownerAt: "2026-11-14T07:00:00.000Z",
    });
    await run(queue, new Date("2026-11-14T07:05:00Z"), false);
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      rows: ["w-n-inputs", "w-n-a"],
      day: { applied: true },
    });
    expect(queue.data("items", "d-hr-focus-20261114").archived).toBe(true);
  });

  it("skips the focus step when the checks list is cut", async () => {
    const queue = setup();
    inbox(queue, "i-1", "сделайте APP-9 и APP-1", "2026-11-13T10:00:00Z");
    const client = queue.client();
    const list = client.list;
    client.list = async (collection, offset) => {
      const page = await list(collection, offset);
      return collection === "checks" ? { ...page, truncated: true } : page;
    };
    await planPass(
      { client, config, store, now: () => DAY1 },
      { hourly: false, daily: true },
    );
    expect(queue.data("work", "focus-hr-helper")).toEqual({});
    expect(queue.data("items", "d-hr-focus-20261114")).toEqual({});
  });
});

describe("ownerReverts (TB-107)", () => {
  const doc = (id: string, data: Record<string, unknown>): QueueDoc => ({
    id,
    data,
    version: 1,
    updatedAt: 0,
  });
  const decision = (id: string) =>
    doc(id, { kind: "decision", title: "x", archived: true });

  it("takes the owner's latest «Вернуть» on a focus item of each product, 7 days back", () => {
    const items = [
      decision("d-hr-focus-20261112"),
      decision("d-hr-focus-20261113"),
      decision("d-taibe-focus-20261113"),
      decision("d-taibe-focus-20261114"),
      decision("d-hr-due-20261113"),
      decision("d-hr-focus-20261101"),
    ];
    const checks = [
      doc("d-hr-focus-20261112", {
        choice: "revert",
        ownerAt: "2026-11-12T09:00:00Z",
      }),
      doc("d-hr-focus-20261113", {
        choice: "revert",
        ownerAt: "2026-11-13T09:00:00Z",
      }),
      // An agent's status, and the owner's note without «Вернуть», do not count.
      doc("d-taibe-focus-20261113", {
        agentNote: "revert",
        agentStatus: "done",
      }),
      doc("d-taibe-focus-20261114", {
        note: "ок",
        ownerAt: "2026-11-13T12:00:00Z",
      }),
      doc("d-hr-due-20261113", {
        choice: "revert",
        ownerAt: "2026-11-13T10:00:00Z",
      }),
      doc("d-hr-focus-20261101", {
        choice: "revert",
        ownerAt: "2026-11-01T09:00:00Z",
      }),
      doc("d-hr-focus-20261199", {
        choice: "revert",
        ownerAt: "2026-11-13T11:00:00Z",
      }),
    ];
    expect(ownerReverts(items, checks, ["hr-helper", "taibe"], DAY1)).toEqual(
      new Map([["hr-helper", Date.parse("2026-11-13T09:00:00Z")]]),
    );
  });
});
