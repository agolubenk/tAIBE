import { describe, expect, it } from "vite-plus/test";
import { type PlanStore, planPass } from "./plan-pass";
import type { BoardCard } from "./plan-types";
import {
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
  QueueRejected,
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
// a work row needs dueRef = an item naming the row, answered «move» after its
// last change, not later than its moveTo date, used once (TB-112 part 1, PR
// #156). race() — another writer moves the doc before the next write; refuse()
// — the console refuses every write of the doc with 409; reject() — with 422;
// allow() ends both. agentNote of a check is 2000 at most (checkSchema). afterGet() — the owner
// acts right after the pass read a doc.
class MemQueue {
  readonly docs = new Map<string, QueueDoc>();
  readonly writes: string[] = [];
  private clock = Date.parse("2026-11-13T00:00:00Z");
  private readonly races = new Set<string>();
  private readonly refused = new Set<string>();
  private readonly rejected = new Set<string>();
  private readonly hooks = new Map<string, () => void>();

  race(collection: QueueCollection, id: string) {
    this.races.add(`${collection}/${id}`);
  }

  refuse(collection: QueueCollection, id: string) {
    this.refused.add(`${collection}/${id}`);
  }

  reject(collection: QueueCollection, id: string) {
    this.rejected.add(`${collection}/${id}`);
  }

  allow(collection: QueueCollection, id: string) {
    this.refused.delete(`${collection}/${id}`);
    this.rejected.delete(`${collection}/${id}`);
  }

  afterGet(collection: QueueCollection, id: string, act: () => void) {
    this.hooks.set(`${collection}/${id}`, act);
  }

  // The owner's answer; the console stamps ownerAt.
  answer(id: string, choice: string) {
    this.set("checks", id, {
      choice,
      done: true,
      ownerAt: new Date((this.clock += 1000)).toISOString(),
    });
  }

  doc(collection: QueueCollection, id: string) {
    return this.docs.get(`${collection}/${id}`);
  }

  data(collection: QueueCollection, id: string) {
    return this.doc(collection, id)?.data ?? {};
  }

  set(collection: QueueCollection, id: string, data: Record<string, unknown>) {
    const version = (this.doc(collection, id)?.version ?? 0) + 1;
    this.clock += 1000;
    this.docs.set(`${collection}/${id}`, {
      id,
      data,
      version,
      updatedAt: this.clock,
    });
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
    const itemDoc = this.doc("items", String(ref));
    const item = itemDoc?.data ?? {};
    const check = this.data("checks", String(ref));
    const moveTo = (item.moveTo ?? {}) as Record<string, string>;
    const used = Array.isArray(before.dueRefs) ? before.dueRefs : [];
    if (
      !Array.isArray(item.rows) ||
      !item.rows.includes(id) ||
      check.choice !== "move" ||
      (itemDoc?.updatedAt ?? 0) > Date.parse(String(check.ownerAt)) ||
      !(next <= String(moveTo[id] ?? "")) ||
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
    const key = `${collection}/${id}`;
    if (this.refused.has(key)) throw new QueueConflict("refused");
    if (this.rejected.has(key)) {
      throw new QueueRejected(`HTTP 422 ${key} is too large`, 422);
    }
    if (this.races.delete(key)) {
      const moved = this.doc(collection, id);
      if (moved) this.set(collection, id, { ...moved.data });
      throw new QueueConflict("version");
    }
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
    if (String(next.agentNote ?? "").length > 2000) {
      throw new QueueRejected("HTTP 422 agentNote is over 2000", 422);
    }
    this.writes.push(`${collection}/${id}`);
    this.set(collection, id, next);
    return structuredClone(this.doc(collection, id) as QueueDoc);
  }

  client(): QueueClient {
    return {
      get: async (collection, id) => {
        const doc = this.doc(collection, id);
        const read = doc ? structuredClone(doc) : null;
        const key = `${collection}/${id}`;
        this.hooks.get(key)?.();
        this.hooks.delete(key);
        return read;
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
    queue.answer("d-taibe-due-20261113", choice);
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

  it("keep without a backlog row leaves the cards and tells the owner on the decision", async () => {
    const queue = await answered("keep", false);
    await run(queue);
    expect(queue.data("work", "w-taibe-a").cards).toHaveLength(6);
    const note =
      "В строки бэклога ушло карточек: 0. Нет строки бэклога в направлении taibe-boards — хвосты остались в строках.";
    expect(queue.data("checks", "d-taibe-due-20261113")).toMatchObject({
      agentStatus: "done",
      agentNote: note,
    });
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      note,
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

// Control on fda3e5bc3: the answer applies what the owner read in the item,
// never the agent's state doc; a failed write never loses a card or a day.
describe("TB-112: the answer follows the item the owner read", () => {
  const backlogRow = (queue: MemQueue, id = "w-taibe-tb-backlog") =>
    queue.set("work", id, {
      title: "Бэклог",
      track: "taibe-boards",
      status: "planned",
      who: "agent",
      cards: [card("TB-99")],
    });
  async function decided(withBacklog = true) {
    const queue = new MemQueue();
    plan(queue);
    if (withBacklog) backlogRow(queue);
    await daily(queue, DAY1);
    return queue;
  }
  const ITEM = "d-taibe-due-20261113";
  const run = (queue: MemQueue, now = DAY2, cfg = config) =>
    planPass(
      {
        client: queue.client(),
        config: cfg,
        store: store([...keys(20), ...keys(2, 50)], 14),
        now: () => now,
      },
      { hourly: false, daily: false },
    );
  const cardsOf = (queue: MemQueue, id: string) =>
    (queue.data("work", id).cards as { key: string }[]).map((c) => c.key);
  const editState = (
    queue: MemQueue,
    edit: (row: Record<string, unknown>) => void,
  ) => {
    const state = structuredClone(queue.data("work", "due-taibe"));
    for (const row of state.rows as Record<string, unknown>[]) edit(row);
    queue.set("work", "due-taibe", state);
  };

  it("puts the move date and the cut cards into the item", async () => {
    const queue = await decided();
    expect(queue.data("items", ITEM)).toMatchObject({
      rows: ["w-taibe-a"],
      moveTo: { "w-taibe-a": "2026-11-19" },
      due: [{ id: "w-taibe-a", cut: ["TB-6", "TB-5", "TB-4", "TB-3", "TB-2"] }],
      source: "t-boards (TB-112)",
    });
  });

  it("move: the date comes from the item, not from the state doc", async () => {
    const queue = await decided();
    editState(queue, (row) => {
      row.eta = "2026-12-31";
    });
    queue.answer(ITEM, "move");
    await run(queue);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-19");
    expect(queue.data("checks", ITEM)).toMatchObject({
      agentStatus: "done",
      agentNote: "Перенесено строк: 1.",
    });
  });

  it("keep: the cut cards come from the item, not from the state doc", async () => {
    const queue = await decided();
    editState(queue, (row) => {
      row.cut = ["TB-1", "TB-2"];
    });
    queue.answer(ITEM, "keep");
    await run(queue);
    expect(cardsOf(queue, "w-taibe-a")).toEqual(["TB-1"]);
    expect(cardsOf(queue, "w-taibe-tb-backlog")).toEqual([
      "TB-99",
      "TB-2",
      "TB-3",
      "TB-4",
      "TB-5",
      "TB-6",
    ]);
  });

  it("a replayed answer applies nothing: the spent item is archived", async () => {
    const queue = await decided();
    queue.answer(ITEM, "move");
    await run(queue);
    // The agent turns the state back to «not applied» on the same item.
    queue.set("work", "due-taibe", {
      ...queue.data("work", "due-taibe"),
      applied: false,
    });
    queue.set("work", "w-taibe-a", {
      ...queue.data("work", "w-taibe-a"),
      planEnd: "2026-11-14",
    });
    queue.writes.length = 0;
    await run(queue, DAY3);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");
    expect(queue.writes).toEqual(["work/due-taibe"]);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      note: `решение ${ITEM} в архиве или не найдено — не применяю`,
    });
  });

  it("an item changed after the answer is not applied, and the next day asks again", async () => {
    const queue = await decided();
    queue.answer(ITEM, "move");
    queue.set("items", ITEM, {
      ...queue.data("items", ITEM),
      moveTo: { "w-taibe-a": "2026-12-31" },
    });
    await run(queue);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");
    expect(queue.data("items", ITEM).archived).toBe(true);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      rows: [],
    });
    await daily(queue, DAY2);
    expect(queue.data("items", "d-taibe-due-20261114").rows).toEqual([
      "w-taibe-a",
    ]);
  });

  it("keep: a 409 on the backlog row keeps every card; the next run finishes", async () => {
    const queue = await decided();
    queue.answer(ITEM, "keep");
    queue.race("work", "w-taibe-tb-backlog");
    await run(queue);
    expect(cardsOf(queue, "w-taibe-a")).toHaveLength(6);
    expect(cardsOf(queue, "w-taibe-tb-backlog")).toEqual(["TB-99"]);
    expect(queue.data("work", "due-taibe").applied).toBe(false);
    await run(queue);
    expect(cardsOf(queue, "w-taibe-a")).toEqual(["TB-1"]);
    expect(cardsOf(queue, "w-taibe-tb-backlog")).toHaveLength(6);
    expect(queue.data("work", "due-taibe").applied).toBe(true);
  });

  it("keep never puts a card into another product's backlog row", async () => {
    const queue = await decided(false);
    // An HR row of the same direction (no prefix: hr-helper).
    backlogRow(queue, "w-boards-backlog");
    const both: OwnerQueueConfig = {
      ...config,
      plan: {
        products: new Map([
          ["ws-eval", "taibe"],
          ["ws-hr", "hr-helper"],
        ]),
      },
    };
    queue.answer(ITEM, "keep");
    await run(queue, DAY2, both);
    expect(cardsOf(queue, "w-boards-backlog")).toEqual(["TB-99"]);
    expect(cardsOf(queue, "w-taibe-a")).toHaveLength(6);
    expect(String(queue.data("checks", ITEM).agentNote)).toContain(
      "Нет строки бэклога в направлении taibe-boards",
    );
  });

  it("move: a race waits for the next run", async () => {
    const queue = await decided();
    queue.answer(ITEM, "move");
    queue.race("work", "w-taibe-a");
    await run(queue);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");
    expect(queue.data("work", "due-taibe").applied).toBe(false);
    await run(queue);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-19");
    expect(queue.data("work", "due-taibe").applied).toBe(true);
  });

  it("move: a move the queue refuses is told to the owner and the answer closes", async () => {
    const queue = await decided();
    queue.answer(ITEM, "move");
    queue.refuse("work", "w-taibe-a");
    await run(queue);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-14");
    expect(queue.data("checks", ITEM).agentNote).toBe(
      "Перенесено строк: 0. Очередь не приняла перенос: «Строка A» — срок остался прежним.",
    );
    expect(queue.data("items", ITEM).archived).toBe(true);
    expect(queue.data("work", "due-taibe").applied).toBe(true);
  });

  it("the item written but not the state: the next run points the state to it", async () => {
    const queue = new MemQueue();
    plan(queue);
    queue.race("work", "due-taibe");
    const first = await daily(queue, DAY1);
    expect(first.dailyDone).toBe(false);
    expect(queue.doc("items", ITEM)).toBeDefined();
    expect(queue.doc("work", "due-taibe")).toBeUndefined();
    const second = await daily(queue, DAY1);
    expect(second.dailyDone).toBe(true);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      item: ITEM,
      applied: false,
      rows: [{ id: "w-taibe-a", eta: "2026-11-19" }],
    });
  });

  it("the daily run after an applied move asks nothing: the row is on time", async () => {
    const queue = await decided();
    queue.answer(ITEM, "move");
    await run(queue);
    queue.writes.length = 0;
    await daily(queue, DAY2);
    await daily(queue, DAY3);
    expect(queue.doc("items", "d-taibe-due-20261114")).toBeUndefined();
    expect(queue.doc("items", "d-taibe-due-20261115")).toBeUndefined();
    expect(queue.data("work", "due-taibe").applied).toBe(true);
    expect(queue.data("work", "w-taibe-a").planEnd).toBe("2026-11-19");
  });

  it("a refused write (422) closes the answer unapplied, tells the owner, and the run goes on", async () => {
    const queue = await decided();
    queue.answer(ITEM, "keep");
    queue.reject("work", "w-taibe-tb-backlog");
    await expect(run(queue)).resolves.toMatchObject({ left: 0 });
    expect(cardsOf(queue, "w-taibe-a")).toEqual(keys(6));
    expect(queue.data("checks", ITEM).agentStatus).toBe("done");
    const note = String(queue.data("checks", ITEM).agentNote);
    expect(note).toContain("Ответ не применён: очередь отказала в записи");
    expect(note).toContain("Срок и строки не менялись.");
    // As an applied answer: the item is archived (a second answer there would
    // be lost), the state closes with no rows.
    expect(queue.data("items", ITEM).archived).toBe(true);
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      rows: [],
    });
    // Closed: the next runs do not try again every 5 minutes.
    queue.writes.length = 0;
    await run(queue, DAY3);
    expect(queue.writes).toEqual([]);
    // The next daily run asks again from the actual plan.
    queue.allow("work", "w-taibe-tb-backlog");
    await daily(queue, DAY3);
    expect(queue.data("items", "d-taibe-due-20261115")).toMatchObject({
      rows: ["w-taibe-a"],
    });
    expect(queue.data("work", "due-taibe")).toMatchObject({
      item: "d-taibe-due-20261115",
      applied: false,
    });
  });

  it("a refusal midway names the rows already written", async () => {
    const queue = await decided();
    queue.answer(ITEM, "keep");
    // keep writes the backlog row first, then the row that loses the cards.
    queue.reject("work", "w-taibe-a");
    await run(queue);
    expect(cardsOf(queue, "w-taibe-tb-backlog")).toHaveLength(6);
    expect(cardsOf(queue, "w-taibe-a")).toEqual(keys(6));
    const note = String(queue.data("checks", ITEM).agentNote);
    expect(note).toContain(
      "До отказа уже изменены строки: «Бэклог»; остальные — нет.",
    );
    expect(note).not.toContain("не менялись");
    expect(queue.data("work", "due-taibe")).toMatchObject({
      applied: true,
      rows: [],
    });
  });

  it("a long outcome note is cut to the queue's 2000 characters", async () => {
    const queue = new MemQueue();
    plan(queue);
    queue.set("work", "w-taibe-a", {
      ...queue.data("work", "w-taibe-a"),
      title: "Т".repeat(2100),
    });
    await daily(queue, DAY1);
    queue.answer(ITEM, "move");
    queue.refuse("work", "w-taibe-a");
    await run(queue);
    const note = String(queue.data("checks", ITEM).agentNote);
    expect(note).toHaveLength(2000);
    expect(note.startsWith("Перенесено строк: 0.")).toBe(true);
    expect(note.endsWith("…")).toBe(true);
    expect(queue.data("checks", ITEM).agentStatus).toBe("done");
  });

  it("an answer that comes during the run is not lost to the new decision", async () => {
    const queue = await decided();
    plan(queue, keys(7));
    // The owner answers right after the answer pass read the old decision.
    queue.afterGet("checks", ITEM, () => queue.answer(ITEM, "move"));
    const first = await daily(queue, DAY2);
    expect(first.dailyDone).toBe(false);
    expect(queue.data("items", ITEM).archived).toBeUndefined();
    expect(queue.doc("items", "d-taibe-due-20261114")).toBeUndefined();
    // The next run applies it first.
    await daily(queue, DAY2);
    expect(queue.data("work", "w-taibe-a")).toMatchObject({
      planEnd: "2026-11-19",
      dueRefs: [ITEM],
    });
    expect(queue.data("items", ITEM).archived).toBe(true);
  });
});
