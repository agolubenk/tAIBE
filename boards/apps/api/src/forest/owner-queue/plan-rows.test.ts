import { describe, expect, it } from "vite-plus/test";
import { type HourlyInput, planWrites } from "./plan-rows";
import type { BoardCard, PlanRow, RecentCard } from "./plan-types";

const TODAY = "2026-11-13";
const NOW = new Date("2026-11-13T12:00:00Z");
const WS = "aiboards-eval";
const uid = (key: string) => `${WS}/${key}`;
const at = (status: string, final = false): BoardCard => ({
  status,
  final,
  closedAt: final ? new Date("2026-11-12T10:00:00Z") : null,
});
const entry = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  ws: WS,
  t: `title ${key}`,
  k: "task",
  s: "P2",
  st: "to-do",
  ...extra,
});
const row = (
  id: string,
  data: Record<string, unknown>,
  version = 4,
): PlanRow => ({
  id,
  version,
  data: { status: "planned", who: "agent", ...data },
});

function hourly(input: Partial<HourlyInput> = {}): HourlyInput {
  return {
    abandoned: new Set(),
    recent: [],
    products: ["taibe"],
    now: NOW,
    ...input,
  };
}

function plan(
  rows: PlanRow[],
  board: [string, BoardCard][],
  hourlyInput: HourlyInput | null = null,
) {
  return planWrites({
    rows,
    board: new Map(board),
    today: TODAY,
    hourly: hourlyInput,
  });
}

describe("planWrites (TB-106)", () => {
  it("sets st to the column slug and leaves unknown cards as they are", () => {
    const legacy = { id: "0".repeat(32), t: "old", st: "открыто" };
    const { writes } = plan(
      [row("w-a", { cards: [entry("TB-1"), entry("TB-2"), legacy] })],
      [[uid("TB-1"), at("in-review")]],
    );
    expect(writes).toEqual([
      {
        id: "w-a",
        version: 4,
        rank: 0,
        patch: {
          cards: [entry("TB-1", { st: "in-review" }), entry("TB-2"), legacy],
          status: "doing",
        },
      },
    ]);
  });

  it("writes nothing when nothing changed", () => {
    const { writes } = plan(
      [
        row("w-a", {
          status: "doing",
          cards: [entry("TB-1", { st: "in-progress" })],
        }),
      ],
      [[uid("TB-1"), at("in-progress")]],
    );
    expect(writes).toEqual([]);
  });

  it("updates st of blocked and owner rows but not their status", () => {
    const { writes } = plan(
      [
        row("w-b", { status: "blocked", cards: [entry("TB-1")] }),
        row("w-o", { who: "owner", cards: [entry("TB-2")] }),
      ],
      [
        [uid("TB-1"), at("done", true)],
        [uid("TB-2"), at("done", true)],
      ],
    );
    expect(writes.map((write) => write.patch)).toEqual([
      { cards: [entry("TB-1", { st: "done" })] },
      { cards: [entry("TB-2", { st: "done" })] },
    ]);
  });

  it("closes a row, never writes planEnd, and puts status writes first", () => {
    const { writes } = plan(
      [
        row("w-st", { cards: [entry("TB-3")] }),
        row("w-done", {
          planEnd: "2026-11-10",
          cards: [entry("TB-1", { st: "done" })],
        }),
      ],
      [
        [uid("TB-1"), at("done", true)],
        [uid("TB-3"), at("grilling")],
      ],
    );
    expect(writes.map((write) => [write.id, write.patch])).toEqual([
      ["w-done", { status: "done", end: TODAY }],
      ["w-st", { cards: [entry("TB-3", { st: "grilling" })] }],
    ]);
    for (const write of writes)
      expect(write.patch).not.toHaveProperty("planEnd");
  });

  it("marks an abandoned card «без аренды» in every row that holds it (F9)", () => {
    const { writes } = plan(
      [
        row("w-a", {
          status: "doing",
          cards: [entry("TB-1", { st: "in-progress" })],
        }),
        row("w-b", {
          status: "done",
          cards: [entry("TB-1", { st: "in-progress" })],
        }),
      ],
      [[uid("TB-1"), at("in-progress")]],
      hourly({ abandoned: new Set([uid("TB-1")]) }),
    );
    const marked = entry("TB-1", { st: "in-progress", mark: "без аренды" });
    expect(writes.map((write) => [write.id, write.patch])).toEqual([
      ["w-b", { cards: [marked], status: "doing" }],
      ["w-a", { cards: [marked] }],
    ]);
  });

  it("clears the mark once the card has a lease or moved on (F9)", () => {
    const marked = entry("TB-1", { st: "in-progress", mark: "без аренды" });
    const rows = [row("w-a", { status: "doing", cards: [marked] })];
    const board: [string, BoardCard][] = [[uid("TB-1"), at("in-progress")]];
    expect(
      plan(rows, board, hourly()).writes.map((write) => write.patch),
    ).toEqual([{ cards: [entry("TB-1", { st: "in-progress" })] }]);
    // Between the hourly runs the mark stays.
    expect(plan(rows, board).writes).toEqual([]);
  });

  it("does not clear a mark of a card the board does not know", () => {
    const marked = entry("TB-9", { mark: "без аренды" });
    const { writes } = plan([row("w-a", { cards: [marked] })], [], hourly());
    expect(writes).toEqual([]);
  });

  it("fills the off-plan row, keeps its status and skips planned cards (F8)", () => {
    const recent = (
      key: string,
      status: string,
      final = false,
    ): RecentCard => ({
      ...at(status, final),
      ws: WS,
      key,
      product: "taibe",
      title: `title ${key}`,
      bug: false,
      level: "P2",
    });
    const { writes } = plan(
      [
        row("w-taibe-unplanned", {
          status: "doing",
          cards: [entry("TB-1", { st: "done" })],
        }),
        row("w-closed", {
          status: "done",
          cards: [entry("TB-2", { st: "done" })],
        }),
      ],
      [
        [uid("TB-1"), at("done", true)],
        [uid("TB-2"), at("done", true)],
      ],
      hourly({
        recent: [recent("TB-2", "done", true), recent("TB-4", "in-progress")],
        abandoned: new Set([uid("TB-4")]),
      }),
    );
    expect(writes).toEqual([
      {
        id: "w-taibe-unplanned",
        version: 4,
        rank: 1,
        patch: {
          cards: [
            entry("TB-1", { st: "done" }),
            entry("TB-4", { st: "in-progress", mark: "без аренды" }),
          ],
        },
      },
    ]);
  });

  it("reports a product without its off-plan row and does not create it", () => {
    const { writes, missing } = plan(
      [],
      [],
      hourly({ products: ["taibe", "hr-helper"] }),
    );
    expect(writes).toEqual([]);
    expect(missing).toEqual(["w-taibe-unplanned", "w-hr-helper-unplanned"]);
  });
});
