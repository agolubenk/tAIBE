import { describe, expect, it } from "vite-plus/test";
import { OFF_PLAN_MAX, refreshOffPlan } from "./plan-off-plan";
import type { BoardCard, RecentCard } from "./plan-types";

const NOW = new Date("2026-11-13T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const WS = "aiboards-eval";

const recent = (key: string, extra: Partial<RecentCard> = {}): RecentCard => ({
  ws: WS,
  key,
  product: "taibe",
  title: `title ${key}`,
  bug: false,
  level: "P2",
  status: "in-progress",
  final: false,
  closedAt: null,
  ...extra,
});
const entry = (key: string, st = "in-progress") => ({ key, ws: WS, st });
const keys = (cards: unknown[]) =>
  cards.map((card) => (card as { key?: string }).key ?? card);

function refresh(input: {
  cards?: unknown[];
  board?: [string, BoardCard][];
  planned?: string[];
  recent?: RecentCard[];
}) {
  return refreshOffPlan({
    cards: input.cards ?? [],
    board: new Map(input.board ?? []),
    planned: new Set(input.planned ?? []),
    recent: input.recent ?? [],
    now: NOW,
  });
}

describe("refreshOffPlan (TB-106 F8)", () => {
  it("appends a moved card that no plan row holds, in the row format", () => {
    const cards = refresh({
      cards: [entry("TB-1")],
      recent: [
        recent("TB-2", { bug: true, level: "high", status: "in-review" }),
      ],
    });
    expect(cards).toEqual([
      entry("TB-1"),
      {
        key: "TB-2",
        ws: WS,
        t: "title TB-2",
        k: "bug",
        s: "high",
        st: "in-review",
      },
    ]);
  });

  it("keeps one entry per card", () => {
    const cards = refresh({
      cards: [entry("TB-1"), entry("tb-1"), entry("TB-3")],
      recent: [recent("TB-1"), recent("TB-3"), recent("TB-4"), recent("TB-4")],
    });
    expect(keys(cards)).toEqual(["TB-1", "TB-3", "TB-4"]);
  });

  it("removes a card once a plan row holds it and does not add it back", () => {
    const cards = refresh({
      cards: [entry("TB-1"), entry("TB-2")],
      planned: [`${WS}/TB-1`, `${WS}/TB-5`],
      recent: [recent("TB-1"), recent("TB-5")],
    });
    expect(keys(cards)).toEqual(["TB-2"]);
  });

  it("removes a card closed more than 14 days ago and keeps a fresher one", () => {
    const closed = (days: number): BoardCard => ({
      status: "done",
      final: true,
      closedAt: daysAgo(days),
    });
    const cards = refresh({
      cards: [entry("TB-1", "done"), entry("TB-2", "done"), entry("TB-3")],
      board: [
        [`${WS}/TB-1`, closed(15)],
        [`${WS}/TB-2`, closed(13)],
      ],
    });
    expect(keys(cards)).toEqual(["TB-2", "TB-3"]);
  });

  it("does not append a card closed more than 14 days ago", () => {
    const cards = refresh({
      recent: [
        recent("TB-1", { status: "done", final: true, closedAt: daysAgo(20) }),
        recent("TB-2", { status: "done", final: true, closedAt: daysAgo(2) }),
      ],
    });
    expect(keys(cards)).toEqual(["TB-2"]);
  });

  it("keeps legacy entries it cannot resolve", () => {
    const legacy = { id: "0".repeat(32), t: "old" };
    expect(refresh({ cards: ["raw", legacy] })).toEqual(["raw", legacy]);
  });

  it("stops at the page's 150 cards", () => {
    const many = Array.from({ length: OFF_PLAN_MAX }, (_, i) =>
      entry(`TB-${i + 1}`),
    );
    const cards = refresh({ cards: many, recent: [recent("TB-999")] });
    expect(cards).toHaveLength(OFF_PLAN_MAX);
    expect(keys(cards)).not.toContain("TB-999");
  });
});
