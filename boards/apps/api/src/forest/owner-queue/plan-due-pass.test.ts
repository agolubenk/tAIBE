import { describe, expect, it } from "vite-plus/test";
import { type PlanStore, planPass } from "./plan-pass";
import type { BoardCard } from "./plan-types";
import {
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";

const WS = "aiboards-eval";
const config: OwnerQueueConfig = {
  url: "http://queue.test",
  tokenFile: "/dev/null",
  tokenName: "token:t-boards",
  products: new Map([["ws-eval", "hr-helper"]]),
  plan: { products: new Map([["ws-eval", "taibe"]]) },
};
// 09:00 Moscow.
const DAY1 = new Date("2026-11-13T06:00:00Z");
const DAY2 = new Date("2026-11-14T06:00:00Z");
const DAY3 = new Date("2026-11-15T06:00:00Z");

// The console's rules for the docs the pass writes: PATCH merges and null
// removes; ifVersion must match; ifVersion 0 creates only. A later planEnd on
// a work row needs dueRef = an item naming the row, answered «move», used
// once (TB-112 part 1, PR #156).
class MemQueue {
  readonly docs = new Map<string, QueueDoc>();
  readonly writes: string[] = [];

  doc(collection: QueueCollection, id: string) {
    return this.docs.get(`${collection}/${id}`);
  }

  data(collection: QueueCollection, id: string) {
    return this.doc(collection, id)?.data ?? {};
  }

  set(collection: QueueCollection, id: string, data: Record<string, unknown>) {
    const version = (this.doc(collection, id)?.version ?? 0) + 1;
    this.docs.set(`${collection}/${id}`, { id, data, version, updatedAt: 0 });
  }

  private guard(
    id: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    const ref = after.dueRef;
    delete after.dueRef;
    const prev = String(before.planEnd ?? "");
    const next = String(after.planEnd ?? "");
    if (!prev || next <= prev) return;
    const item = this.data("items", String(ref));
    const used = Array.isArray(before.dueRefs) ? before.dueRefs : [];
    if (
      !Array.isArray(item.rows) ||
      !item.rows.includes(id) ||
      this.data("checks", String(ref)).choice !== "move" ||
      used.includes(ref)
    ) {
      throw new QueueConflict("planEnd");
    }
    after.dueRefs = [...used, ref];
    if (before.basePlanEnd === undefined) after.basePlanEnd = before.planEnd;
  }

  private write(
    collection: QueueCollection,
    id: string,
    data: Record<string, unknown>,
    merge: boolean,
    ifVersion?: number,
  ): QueueDoc {
    const current = this.doc(collection, id);
    if (ifVersion === 0 && current) throw new QueueConflict("exists");
    if (ifVersion !== undefined && (current?.version ?? 0) !== ifVersion) {
      throw new QueueConflict("version");
    }
    if (merge && !current) throw new Error(`PATCH of a missing ${id}`);
    const next: Record<string, unknown> = merge
      ? { ...current?.data, ...data }
      : { ...data };
    for (const [key, value] of Object.entries(next)) {
      if (value === null) delete next[key];
    }
    if (collection === "work") this.guard(id, current?.data ?? {}, next);
    this.writes.push(`${collection}/${id}`);
    this.set(collection, id, next);
    return structuredClone(this.doc(collection, id) as QueueDoc);
  }

  client(): QueueClient {
    return {
      get: async (collection, id) => {
        const doc = this.doc(collection, id);
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

const card = (key: string, k = "task", s = "P2") => ({
  key,
  ws: WS,
  k,
  s,
  st: "to-do",
});
const keys = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `TB-${from + i}`);
const todo: BoardCard = { status: "to-do", final: false, closedAt: null };

function store(board: string[], closed: number): PlanStore {
  return {
    resolve: async () =>
      new Map(board.map((key) => [`${WS}/${key}`, todo] as const)),
    recent: async () => [],
    named: async () => [],
    abandoned: async () => new Set(),
    closed: async (products) =>
      new Map([...new Set(products.values())].map((p) => [p, closed])),
  };
}

// Pace 1 a day (14 closed). w-taibe-a: 6 open, term 14.11 → eta 19.11, late by
// 5. w-taibe-b: 2 more, term 30.11 → eta 21.11, on time.
function plan(queue: MemQueue, aCards = keys(6)) {
  queue.set("work", "w-taibe-a", {
    title: "Строка A",
    track: "taibe-boards",
    status: "doing",
    who: "agent",
    planStart: "2026-11-10",
    planEnd: "2026-11-14",
    cards: aCards.map((key) => card(key)),
  });
  queue.set("work", "w-taibe-b", {
    title: "Строка B",
    track: "taibe-boards",
    status: "planned",
    who: "agent",
    planStart: "2026-11-12",
    planEnd: "2026-11-30",
    cards: keys(2, 50).map((key) => card(key)),
  });
}

const daily = (
  queue: MemQueue,
  now: Date,
  board = [...keys(20), ...keys(2, 50)],
  closed = 14,
) =>
  planPass(
    {
      client: queue.client(),
      config,
      store: store(board, closed),
      now: () => now,
    },
    { hourly: false, daily: true },
  );

describe("TB-112: forecast and one due decision", () => {
  it("writes eta, asks once about the late rows and not again on an unchanged set", async () => {
    const queue = new MemQueue();
    plan(queue);
    const outcome = await daily(queue, DAY1);
    expect(outcome).toMatchObject({ skipped: 0, left: 0, dailyDone: true });
    expect(queue.data("work", "w-taibe-a").eta).toBe("2026-11-19");
    expect(queue.data("work", "w-taibe-b").eta).toBe("2026-11-21");
    expect(queue.data("items", "d-taibe-due-20261113")).toMatchObject({
      kind: "decision",
      rows: ["w-taibe-a"],
    });
    expect(queue.data("work", "due-taibe")).toMatchObject({
      kind: "due",
      item: "d-taibe-due-20261113",
      applied: false,
      rows: [
        {
          id: "w-taibe-a",
          planEnd: "2026-11-14",
          eta: "2026-11-19",
          lag: 5,
          cut: ["TB-6", "TB-5", "TB-4", "TB-3", "TB-2"],
        },
      ],
    });
    // The planEnd stays: only the owner's «move» shifts it.
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");

    // A restart runs the day again; the next day the lag grew by 1 only.
    queue.writes.length = 0;
    await daily(queue, DAY1);
    await daily(queue, DAY2);
    expect(queue.writes).toEqual([]);
    expect(queue.doc("items", "d-taibe-due-20261114")).toBeUndefined();
  });

  it("asks again on a lag +2 and archives the unanswered decision", async () => {
    const queue = new MemQueue();
    plan(queue);
    await daily(queue, DAY1);
    plan(queue, keys(7));
    await daily(queue, DAY2);
    expect(queue.data("items", "d-taibe-due-20261114").rows).toEqual([
      "w-taibe-a",
    ]);
    expect(queue.data("items", "d-taibe-due-20261113").archived).toBe(true);
    expect(queue.data("work", "due-taibe").item).toBe("d-taibe-due-20261114");
  });

  it("asks nothing and drops eta with «мало данных»", async () => {
    const queue = new MemQueue();
    plan(queue);
    queue.set("work", "w-taibe-a", {
      ...queue.data("work", "w-taibe-a"),
      eta: "2026-11-19",
    });
    await daily(queue, DAY1, undefined, 4);
    expect(queue.data("work", "w-taibe-a").eta).toBeUndefined();
    expect(queue.doc("items", "d-taibe-due-20261113")).toBeUndefined();
    expect(queue.doc("work", "due-taibe")).toBeUndefined();
  });
});

describe("TB-112: the owner's answer", () => {
  async function answered(choice: string, backlog = true) {
    const queue = new MemQueue();
    plan(queue);
    if (backlog) {
      queue.set("work", "w-taibe-tb-backlog", {
        title: "Бэклог",
        track: "taibe-boards",
        status: "planned",
        who: "agent",
        cards: [card("TB-99")],
      });
    }
    await daily(queue, DAY1);
    queue.set("checks", "d-taibe-due-20261113", { choice, done: true });
    return queue;
  }
  // Every 5 minutes, not daily.
  const run = (queue: MemQueue, now = DAY2) =>
    planPass(
      {
        client: queue.client(),
        config,
        store: store([...keys(20), ...keys(2, 50)], 14),
        now: () => now,
      },
      { hourly: false, daily: false },
    );

  it("move: planEnd = eta under the decision's ref, once", async () => {
    const queue = await answered("move");
    await run(queue);
    expect(queue.data("work", "w-taibe-a")).toMatchObject({
      planEnd: "2026-11-19",
      basePlanEnd: "2026-11-14",
      dueRefs: ["d-taibe-due-20261113"],
    });
    expect(queue.data("work", "w-taibe-a")).not.toHaveProperty("dueRef");
    expect(queue.data("items", "d-taibe-due-20261113").archived).toBe(true);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      choice: "move",
    });
    queue.writes.length = 0;
    await run(queue, DAY3);
    expect(queue.writes).toEqual([]);
  });

  it("keep: the cut cards go to the backlog row of the direction, once", async () => {
    const queue = await answered("keep");
    await run(queue);
    const cardsOf = (id: string) =>
      (queue.data("work", id).cards as { key: string }[]).map((c) => c.key);
    expect(cardsOf("w-taibe-a")).toEqual(["TB-1"]);
    expect(cardsOf("w-taibe-tb-backlog")).toEqual([
      "TB-99",
      "TB-2",
      "TB-3",
      "TB-4",
      "TB-5",
      "TB-6",
    ]);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      choice: "keep",
    });
    queue.writes.length = 0;
    await run(queue, DAY3);
    expect(queue.writes).toEqual([]);
  });

  it("keep without a backlog row leaves the cards and says so", async () => {
    const queue = await answered("keep", false);
    await run(queue);
    expect(queue.data("work", "w-taibe-a").cards).toHaveLength(6);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      note: "нет строки бэклога в направлении taibe-boards",
    });
  });

  it("red: nothing moves; the decision is archived and applied", async () => {
    const queue = await answered("red");
    const before = structuredClone(queue.data("work", "w-taibe-a"));
    await run(queue);
    expect(queue.data("work", "w-taibe-a")).toEqual(before);
    expect(queue.data("items", "d-taibe-due-20261113").archived).toBe(true);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      choice: "red",
    });
    // The same late rows next day: «оставить красными» is not asked again.
    queue.writes.length = 0;
    await daily(queue, DAY2);
    expect(queue.doc("items", "d-taibe-due-20261114")).toBeUndefined();
  });

  it("an unanswered decision changes nothing", async () => {
    const queue = new MemQueue();
    plan(queue);
    await daily(queue, DAY1);
    queue.writes.length = 0;
    await run(queue);
    expect(queue.writes).toEqual([]);
  });
});
