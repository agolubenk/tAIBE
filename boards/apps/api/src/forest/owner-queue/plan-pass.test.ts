import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PLAN_WRITES_PER_RUN,
  type PlanStore,
  planPass,
  READ_BUDGET_MS,
} from "./plan-pass";
import type { BoardCard, RecentCard } from "./plan-types";
import {
  listAll,
  type QueueClient,
  type QueueCollection,
  QueueConflict,
  type QueueDoc,
  type QueuePage,
} from "./queue-client";
import type { OwnerQueueConfig } from "./queue-config";

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
// must match (409 otherwise).
class FakeWork {
  readonly docs = new Map<string, QueueDoc>();
  readonly patches: { id: string; data: Record<string, unknown> }[] = [];
  race = new Set<string>();
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
        const doc = this.docs.get(id);
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

  it("writes 30 rows a run at most and leaves the rest for the next run", async () => {
    const queue = new FakeWork();
    for (let i = 0; i < 35; i += 1) {
      queue.add(`w-${i}`, { status: "planned", cards: [card("TB-1")] });
    }
    const board = store({ [`${WS}/TB-1`]: done });
    expect(await run(queue, board)).toMatchObject({
      written: PLAN_WRITES_PER_RUN,
      left: 35 - PLAN_WRITES_PER_RUN,
    });
    expect(await run(queue, board)).toMatchObject({ written: 5, left: 0 });
    expect(await run(queue, board)).toMatchObject({ written: 0, left: 0 });
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
