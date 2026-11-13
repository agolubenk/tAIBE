import { describe, expect, it } from "vite-plus/test";
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
      prev: [],
      day: { item: "d-hr-focus-20261114" },
    });
    expect(queue.data("items", "d-hr-focus-20261114").kind).toBe("decision");

    queue.writes.length = 0;
    await run(queue, DAY1, true);
    expect(queue.writes).toEqual([]);

    inbox(queue, "i-2", "и APP-2", "2026-11-14T12:00:00Z");
    await run(queue, DAY2, true);
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      rows: ["w-n-inputs", "w-n-a", "w-n-b"],
      prev: ["w-n-inputs", "w-n-a"],
      day: { item: "d-hr-focus-20261115" },
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
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      rows: [],
      day: { applied: true },
      reverted: {
        at: "2026-11-14T07:00:00.000Z",
        rows: ["w-n-inputs", "w-n-a"],
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

  it("marks a revert made by hand without moving its rows again", async () => {
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
    queue.set("checks", "d-hr-focus-1311", {
      done: true,
      choice: "revert",
      ownerAt: "2026-11-13T12:17:02.153Z",
    });
    await run(queue, DAY1, false);
    expect(queue.data("work", "focus-hr-helper")).toMatchObject({
      rows: [],
      prev: ["w-n-inputs"],
      day: { applied: true },
      reverted: {
        at: "2026-11-13T12:17:02.153Z",
        rows: ["w-n-inputs"],
        keys: [],
      },
    });
    queue.writes.length = 0;
    await run(queue, new Date("2026-11-14T06:10:00Z"), false);
    expect(queue.writes).toEqual([]);
  });
});
