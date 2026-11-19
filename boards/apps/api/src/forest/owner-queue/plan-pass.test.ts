import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PLAN_WRITES_PER_RUN,
  type PlanStore,
  planCheckIn,
  planPass,
  READ_BUDGET_MS,
  THROTTLED_RUNS_ALERT,
} from "./plan-pass";
import type { BoardCard, RecentCard } from "./plan-types";
import {
  listAll,
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
  type QueuePage,
  QueueRejected,
  QueueThrottled,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";
import { QUEUE_WRITES_PER_MINUTE, WRITES_PER_PASS } from "./queue-limits";

const WS = "aiboards-eval";
const NOW = new Date("2026-11-13T12:00:00Z");
// As on the VPS: one token, one queue product for both workspaces; the plan
// product of aiBoards&eval is taibe (OQ_PLAN_PRODUCTS).
const config: OwnerQueueConfig = {
  url: "http://queue.test",
  tokenFile: "/dev/null",
  tokenName: "token:t-boards",
  products: new Map([
    ["ws-eval", "hr-helper"],
    ["ws-lav", "hr-helper"],
  ]),
  plan: {
    products: new Map([
      ["ws-eval", "taibe"],
      ["ws-lav", "hr-helper"],
    ]),
  },
};
type Moved = Omit<RecentCard, "product">;
const moved = (key: string, ws = WS): Moved => ({
  ws,
  key,
  title: `title ${key}`,
  bug: false,
  level: "P2",
  status: "in-progress",
  final: false,
  closedAt: null,
});
const card = (key: string, st = "to-do") => ({ key, ws: WS, k: "task", st });

// The console's work rules: PATCH merges, a null field is removed, ifVersion
// must match (409 otherwise). reject — docs the console refuses with 422;
// throttleAfter — the writes it takes before it answers 429 (the token's
// minute is spent).
class FakeWork {
  readonly docs = new Map<string, QueueDoc>();
  readonly patches: { id: string; data: Record<string, unknown> }[] = [];
  race = new Set<string>();
  reject = new Set<string>();
  throttleAfter = Number.POSITIVE_INFINITY;
  calls = 0;
  truncated = false;
  // Answer in pages of one doc, as a paging console would (no snapshot).
  paged = false;

  add(id: string, data: Record<string, unknown>, version = 1) {
    this.docs.set(id, {
      id,
      data,
      version,
      updatedAt: 0,
      product: "hr-helper",
    });
  }

  client(): QueueClient {
    const fail = () => Promise.reject(new Error("not used"));
    return {
      get: fail,
      put: fail,
      history: fail,
      list: async (
        _collection: QueueCollection,
        offset: number,
      ): Promise<QueuePage> => {
        const docs = [...this.docs.values()].map((doc) => structuredClone(doc));
        if (!this.paged) {
          return { docs, nextOffset: null, truncated: this.truncated };
        }
        const next = offset + 1 < docs.length ? offset + 1 : null;
        return {
          docs: docs.slice(offset, offset + 1),
          nextOffset: next,
          truncated: this.truncated,
        };
      },
      patch: async (_collection, id, data, ifVersion) => {
        this.calls += 1;
        if (this.calls > this.throttleAfter) {
          throw new QueueThrottled("HTTP 429 Слишком много записей");
        }
        const doc = this.docs.get(id);
        if (this.reject.has(id)) throw new QueueRejected("too large", 422);
        if (!doc || this.race.has(id) || doc.version !== ifVersion) {
          throw new QueueConflict("version");
        }
        this.patches.push({ id, data });
        const merged: Record<string, unknown> = { ...doc.data, ...data };
        for (const [key, value] of Object.entries(merged)) {
          if (value === null) delete merged[key];
        }
        const next = { ...doc, data: merged, version: doc.version + 1 };
        this.docs.set(id, next);
        return next;
      },
    };
  }
}

// recent: [workspace id, card]; the store names the product from the map the
// pass gives it, as plan-store.ts does.
function store(
  board: Record<string, BoardCard>,
  extra: { recent?: [string, Moved][]; abandoned?: string[] } = {},
): PlanStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (workspaceIds) => {
      calls.push(`resolve:${workspaceIds.join(",")}`);
      return new Map(Object.entries(board));
    },
    recent: async (products) => {
      calls.push("recent");
      return (extra.recent ?? []).flatMap(([workspaceId, card]) => {
        const product = products.get(workspaceId);
        return product ? [{ ...card, product }] : [];
      });
    },
    abandoned: async () => {
      calls.push("abandoned");
      return new Set(extra.abandoned ?? []);
    },
    closed: async () => {
      calls.push("closed");
      return new Map();
    },
  };
}

const done: BoardCard = { status: "done", final: true, closedAt: NOW };
const run = (queue: FakeWork, board: PlanStore, hourly = false) =>
  planPass(
    { client: queue.client(), config, store: board, now: () => NOW },
    { hourly, daily: false },
  );

describe("planPass (TB-106)", () => {
  it("closes a row with ifVersion, sets end to the Moscow date and keeps planEnd", async () => {
    const queue = new FakeWork();
    queue.add(
      "w-a",
      {
        status: "doing",
        who: "agent",
        planEnd: "2026-11-10",
        cards: [card("TB-1")],
      },
      7,
    );
    queue.add("track-ops", {
      kind: "track",
      name: "Ops",
      cards: [card("TB-1")],
    });
    const outcome = await run(queue, store({ [`${WS}/TB-1`]: done }));
    expect(outcome).toEqual({
      written: 1,
      skipped: 0,
      left: 0,
      refused: 0,
      throttled: false,
      hourlyDone: false,
      dailyDone: false,
    });
    expect(queue.docs.get("w-a")?.data).toMatchObject({
      status: "done",
      end: "2026-11-13",
      planEnd: "2026-11-10",
      cards: [card("TB-1", "done")],
    });
    expect(queue.docs.get("w-a")?.version).toBe(8);
    expect(queue.docs.get("track-ops")?.version).toBe(1);
  });

  it("reopens a done row and removes its end", async () => {
    const queue = new FakeWork();
    queue.add("w-a", {
      status: "done",
      end: "2026-11-01",
      cards: [card("TB-1", "done")],
    });
    await run(
      queue,
      store({
        [`${WS}/TB-1`]: { status: "to-do", final: false, closedAt: null },
      }),
    );
    expect(queue.docs.get("w-a")?.data).toEqual({
      status: "planned",
      cards: [card("TB-1", "to-do")],
    });
  });

  it("skips a row on 409 until the next run and writes the others", async () => {
    const queue = new FakeWork();
    queue.add("w-a", { status: "planned", cards: [card("TB-1")] });
    queue.add("w-b", { status: "planned", cards: [card("TB-1")] });
    queue.race.add("w-a");
    const board = store({ [`${WS}/TB-1`]: done });
    expect(await run(queue, board, true)).toEqual({
      written: 1,
      skipped: 1,
      left: 0,
      refused: 0,
      throttled: false,
      hourlyDone: false,
      dailyDone: false,
    });
    expect(queue.docs.get("w-a")?.data.status).toBe("planned");
    expect(queue.docs.get("w-b")?.data.status).toBe("done");
    queue.race.clear();
    expect(await run(queue, board, true)).toMatchObject({
      written: 1,
      hourlyDone: true,
    });
  });

  it("skips a row the queue refuses (422), writes the others and counts the run done", async () => {
    const queue = new FakeWork();
    queue.add("w-a", { status: "planned", cards: [card("TB-1")] });
    queue.add("w-b", { status: "planned", cards: [card("TB-1")] });
    queue.reject.add("w-a");
    const board = store({ [`${WS}/TB-1`]: done });
    // Not incomplete: the hourly part would run again every 5 minutes.
    expect(await run(queue, board, true)).toEqual({
      written: 1,
      skipped: 0,
      left: 0,
      refused: 1,
      throttled: false,
      hourlyDone: true,
      dailyDone: false,
    });
    expect(queue.docs.get("w-a")?.data.status).toBe("planned");
    expect(queue.docs.get("w-b")?.data.status).toBe("done");
    // The next run does not throw either.
    await expect(run(queue, board)).resolves.toMatchObject({ refused: 1 });
  });

  it("does not catch a failure of the queue itself", async () => {
    const queue = new FakeWork();
    queue.add("w-a", { status: "planned", cards: [card("TB-1")] });
    const client = queue.client();
    const failing: QueueClient = {
      ...client,
      patch: () => Promise.reject(new Error("queue 503")),
    };
    await expect(
      planPass(
        {
          client: failing,
          config,
          store: store({ [`${WS}/TB-1`]: done }),
          now: () => NOW,
        },
        { hourly: false, daily: false },
      ),
    ).rejects.toThrow("queue 503");
  });

  it("writes PLAN_WRITES_PER_RUN rows a run at most and leaves the rest for the next run", async () => {
    const queue = new FakeWork();
    for (let i = 0; i < 35; i += 1) {
      queue.add(`w-${i}`, { status: "planned", cards: [card("TB-1")] });
    }
    const board = store({ [`${WS}/TB-1`]: done });
    expect(await run(queue, board)).toMatchObject({
      written: PLAN_WRITES_PER_RUN,
      left: 35 - PLAN_WRITES_PER_RUN,
    });
    expect(await run(queue, board)).toMatchObject({
      written: 35 - PLAN_WRITES_PER_RUN,
      left: 0,
    });
    expect(await run(queue, board)).toMatchObject({ written: 0, left: 0 });
  });

  // TB-119: the queue takes 120 writes a minute per token; a minute holds two
  // 30 s passes and one plan run.
  it("keeps two 30 s passes and one plan run within the queue's 120 writes a minute", () => {
    expect(QUEUE_WRITES_PER_MINUTE).toBe(120);
    expect(PLAN_WRITES_PER_RUN).toBe(20);
    expect(2 * WRITES_PER_PASS + PLAN_WRITES_PER_RUN).toBeLessThanOrEqual(
      QUEUE_WRITES_PER_MINUTE,
    );
  });

  it("stops writing on a 429 and leaves the rest for the next run without an error", async () => {
    const queue = new FakeWork();
    for (let i = 0; i < 5; i += 1) {
      queue.add(`w-${i}`, { status: "planned", cards: [card("TB-1")] });
    }
    queue.throttleAfter = 2;
    const board = store({ [`${WS}/TB-1`]: done });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(queue, board, true)).toEqual({
      written: 2,
      skipped: 0,
      left: 3,
      refused: 0,
      throttled: true,
      // Incomplete: the hourly part runs again next run.
      hourlyDone: false,
      dailyDone: false,
    });
    // One 429 call; the rest of the run does not call the queue.
    expect(queue.calls).toBe(3);
    // One warning for the 429, not one per row left.
    expect(
      warn.mock.calls.filter(([text]) => String(text).includes("429")),
    ).toHaveLength(1);
    warn.mockRestore();
    queue.throttleAfter = Number.POSITIVE_INFINITY;
    expect(await run(queue, board, true)).toMatchObject({
      written: 3,
      left: 0,
      hourlyDone: true,
    });
  });

  it("fails the check-in after a 429 in 3 runs in a row, not before, and on a refusal at once", () => {
    const checkIn = planCheckIn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throttled = { refused: 0, throttled: true };
    const clean = { refused: 0, throttled: false };
    for (let run = 1; run < THROTTLED_RUNS_ALERT; run += 1) {
      expect(checkIn(throttled)).toEqual({ degraded: false });
    }
    expect(checkIn(throttled)).toEqual({ degraded: true });
    expect(checkIn(throttled)).toEqual({ degraded: true });
    expect(warn).toHaveBeenCalledTimes(1);
    // A run without a 429 starts the count again.
    expect(checkIn(clean)).toEqual({ degraded: false });
    expect(checkIn(throttled)).toEqual({ degraded: false });
    expect(checkIn({ refused: 1, throttled: false })).toEqual({
      degraded: true,
    });
    warn.mockRestore();
  });

  it("reads the board only in mapped workspaces and runs F8 and F9 only hourly", async () => {
    const queue = new FakeWork();
    queue.add("w-taibe-unplanned", { status: "doing", cards: [] });
    const recent: Moved = {
      ...moved("TB-7"),
      title: "off plan",
      bug: true,
      level: "high",
    };
    const board = store(
      {},
      { recent: [["ws-eval", recent]], abandoned: [`${WS}/TB-7`] },
    );
    await run(queue, board);
    expect(board.calls).toEqual(["resolve:ws-eval,ws-lav"]);
    expect(queue.patches).toEqual([]);
    await run(queue, board, true);
    expect(board.calls).toContain("recent");
    expect(board.calls).toContain("abandoned");
    expect(queue.docs.get("w-taibe-unplanned")?.data.cards).toEqual([
      {
        key: "TB-7",
        ws: WS,
        t: "off plan",
        k: "bug",
        s: "high",
        st: "in-progress",
        mark: "без аренды",
      },
    ]);
  });

  it("makes no off-plan decision on a truncated list", async () => {
    const queue = new FakeWork();
    queue.truncated = true;
    const board = store({});
    expect(await run(queue, board, true)).toMatchObject({ hourlyDone: false });
    expect(board.calls).toEqual(["resolve:ws-eval,ws-lav"]);
  });

  it("follows only the rows of its plan products, by the id prefix", async () => {
    // A board of aiBoards&eval alone: the HR rows (no prefix, queue product
    // hr-helper like every w-… row) are not its rows.
    const own: OwnerQueueConfig = {
      ...config,
      products: new Map([["ws-eval", "hr-helper"]]),
      plan: { products: new Map([["ws-eval", "taibe"]]) },
    };
    const queue = new FakeWork();
    queue.add("w-taibe-a", { status: "doing", cards: [card("TB-1")] });
    queue.add("w-n-high", { status: "doing", cards: [card("TB-1")] });
    queue.add("w-hr-helper-unplanned", { status: "doing", cards: [] });
    const board = store({ [`${WS}/TB-1`]: done });
    await planPass(
      { client: queue.client(), config: own, store: board, now: () => NOW },
      { hourly: false, daily: false },
    );
    expect(queue.patches.map((patch) => patch.id)).toEqual(["w-taibe-a"]);
    expect(queue.docs.get("w-n-high")?.data.status).toBe("doing");
  });

  it("follows the rows of a paged list but makes no off-plan decision on it", async () => {
    const queue = new FakeWork();
    queue.paged = true;
    queue.add("w-a", { status: "doing", cards: [card("TB-1")] });
    queue.add("w-taibe-unplanned", { status: "doing", cards: [] });
    const board = store(
      { [`${WS}/TB-1`]: done },
      { recent: [["ws-eval", moved("TB-7")]] },
    );
    expect(await run(queue, board, true)).toMatchObject({
      written: 1,
      hourlyDone: false,
    });
    expect(board.calls).toEqual(["resolve:ws-eval,ws-lav"]);
    expect(queue.docs.get("w-a")?.data.status).toBe("done");
  });

  describe("read budget", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("skips the hourly reads after a slow board read and still writes, with its own budget", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const queue = new FakeWork();
      queue.add("w-a", { status: "doing", cards: [card("TB-1")] });
      const board = store({ [`${WS}/TB-1`]: done });
      const slow: PlanStore = {
        ...board,
        resolve: async (workspaceIds, refs) => {
          vi.setSystemTime(NOW.getTime() + READ_BUDGET_MS + 1000);
          return board.resolve(workspaceIds, refs);
        },
      };
      expect(await run(queue, slow, true)).toMatchObject({
        written: 1,
        left: 0,
        hourlyDone: false,
      });
      expect(board.calls).toEqual(["resolve:ws-eval,ws-lav"]);
    });
  });

  it("puts an aiBoards&eval card into w-taibe-unplanned while the queue product is hr-helper", async () => {
    const queue = new FakeWork();
    queue.add("w-taibe-unplanned", { status: "doing", cards: [] });
    queue.add("w-hr-helper-unplanned", { status: "doing", cards: [] });
    const board = store(
      {},
      {
        recent: [
          ["ws-eval", moved("TB-7")],
          ["ws-lav", moved("APP-3", "hr-helper-lavaeon")],
        ],
      },
    );
    await run(queue, board, true);
    expect(queue.docs.get("w-taibe-unplanned")?.data.cards).toEqual([
      {
        key: "TB-7",
        ws: WS,
        t: "title TB-7",
        k: "task",
        s: "P2",
        st: "in-progress",
      },
    ]);
    expect(queue.docs.get("w-hr-helper-unplanned")?.data.cards).toEqual([
      {
        key: "APP-3",
        ws: "hr-helper-lavaeon",
        t: "title APP-3",
        k: "task",
        s: "P2",
        st: "in-progress",
      },
    ]);
  });
});

describe("listAll", () => {
  it("follows next_offset and stops when it does not move forward", async () => {
    const offsets: number[] = [];
    const doc = (id: string): QueueDoc => ({
      id,
      data: {},
      version: 1,
      updatedAt: 0,
    });
    const pages: Record<number, QueuePage> = {
      0: { docs: [doc("a")], nextOffset: 500, truncated: false },
      500: { docs: [doc("b")], nextOffset: 500, truncated: false },
    };
    const client = {
      list: async (_collection: QueueCollection, offset: number) => {
        offsets.push(offset);
        return pages[offset] as QueuePage;
      },
    } as QueueClient;
    const all = await listAll(client, "work");
    expect(all.docs.map((d) => d.id)).toEqual(["a", "b"]);
    expect(offsets).toEqual([0, 500]);
    expect(all.snapshot).toBe(false);
  });

  it("calls one page a snapshot", async () => {
    const client = {
      list: async () => ({ docs: [], nextOffset: null, truncated: false }),
    } as unknown as QueueClient;
    expect(await listAll(client, "work")).toEqual({
      docs: [],
      truncated: false,
      snapshot: true,
    });
  });

  it("reads no next page past the deadline and reports a truncated list", async () => {
    const offsets: number[] = [];
    const client = {
      list: async (_collection: QueueCollection, offset: number) => {
        offsets.push(offset);
        return { docs: [], nextOffset: offset + 500, truncated: false };
      },
    } as unknown as QueueClient;
    const all = await listAll(client, "work", Date.now() - 1);
    expect(offsets).toEqual([0]);
    expect(all).toMatchObject({ truncated: true, snapshot: false });
  });
});
