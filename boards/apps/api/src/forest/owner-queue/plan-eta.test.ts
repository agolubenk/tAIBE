import { describe, expect, it } from "vite-plus/test";
import { etaPatch, forecast, forecastRows, pace, rankRows } from "./plan-eta";
import type { BoardCard, PlanRow } from "./plan-types";

const WS = "aiboards-eval";
const TODAY = "2026-11-13";
const PRODUCTS = ["hr-helper", "taibe"];
const open = (status = "to-do"): BoardCard => ({
  status,
  final: false,
  closedAt: null,
});
const closed: BoardCard = { status: "done", final: true, closedAt: null };
const entry = (key: string, k = "task", s = "P2") => ({ key, ws: WS, k, s });
const row = (id: string, data: Record<string, unknown>): PlanRow => ({
  id,
  version: 1,
  data: { status: "planned", who: "agent", planEnd: "2026-11-20", ...data },
});
const board = (cards: Record<string, BoardCard>) =>
  new Map(Object.entries(cards).map(([key, card]) => [`${WS}/${key}`, card]));

describe("pace (TB-112 F7.1)", () => {
  it("is cards closed in 14 days per day, «мало данных» under 5", () => {
    expect(pace(14)).toBe(1);
    expect(pace(7)).toBe(0.5);
    expect(pace(5)).toBeCloseTo(5 / 14);
    expect(pace(4)).toBeNull();
    expect(pace(0)).toBeNull();
  });
});

describe("forecastRows", () => {
  it("keeps open agent rows of the product with a term and a known card", () => {
    const known = board({ "TB-1": open() });
    const rows = [
      row("w-taibe-a", { cards: [entry("TB-1")] }),
      row("w-taibe-done", { status: "done", cards: [entry("TB-1")] }),
      row("w-taibe-blocked", { status: "blocked", cards: [entry("TB-1")] }),
      row("w-taibe-owner", { who: "owner", cards: [entry("TB-1")] }),
      row("w-taibe-unplanned", { cards: [entry("TB-1")] }),
      row("w-taibe-noterm", { planEnd: undefined, cards: [entry("TB-1")] }),
      row("w-taibe-unknown", { cards: [entry("TB-404")] }),
      row("w-n-hr", { cards: [entry("TB-1")] }),
    ];
    expect(
      forecastRows(rows, "taibe", PRODUCTS, known).map((one) => one.id),
    ).toEqual(["w-taibe-a"]);
    expect(
      forecastRows(rows, "hr-helper", PRODUCTS, known).map((one) => one.id),
    ).toEqual(["w-n-hr"]);
  });
});

describe("rankRows (queue_focus.py rank_rows)", () => {
  it("puts the focus order first, then planStart, order and id", () => {
    const rows = [
      row("w-d", { planStart: "2026-11-01" }),
      row("w-c", {}),
      row("w-b", { planStart: "2026-11-05", order: 2 }),
      row("w-a", { planStart: "2026-11-05", order: 1 }),
      row("w-e", { planStart: "2026-11-05", order: 1 }),
      row("w-f", { planStart: "2026-12-01" }),
    ];
    expect(rankRows(rows, ["w-f", "w-x"]).map((one) => one.id)).toEqual([
      "w-f",
      "w-d",
      "w-a",
      "w-e",
      "w-b",
      "w-c",
    ]);
  });
});

describe("forecast (eta and lag)", () => {
  it("adds each row's open cards to the ones before it", () => {
    const known = board({
      "TB-1": open(),
      "TB-2": open("in-progress"),
      "TB-3": closed,
      "TB-4": open(),
      "TB-5": open(),
    });
    const rows = [
      row("w-a", {
        planEnd: "2026-11-14",
        title: "A",
        cards: [entry("TB-1"), entry("TB-2"), entry("TB-3"), entry("TB-9")],
      }),
      // TB-1 counts in the first row only.
      row("w-b", {
        planEnd: "2026-11-20",
        cards: [entry("TB-1"), entry("TB-4"), entry("TB-5", "bug", "high")],
      }),
    ];
    const result = forecast(rows, known, 0.5, TODAY);
    expect(result.map(({ open: cards, ...rest }) => rest)).toEqual([
      {
        id: "w-a",
        title: "A",
        planEnd: "2026-11-14",
        eta: "2026-11-17",
        lag: 3,
      },
      {
        id: "w-b",
        title: "w-b",
        planEnd: "2026-11-20",
        eta: "2026-11-21",
        lag: 1,
      },
    ]);
    expect(result[0]?.open).toEqual([
      { key: "TB-1", bug: false, level: "P2", active: false },
      { key: "TB-2", bug: false, level: "P2", active: true },
    ]);
    expect(result[1]?.open.map((card) => card.key)).toEqual(["TB-4", "TB-5"]);
  });

  it("gives today to a row with nothing open before or in it", () => {
    const result = forecast(
      [row("w-a", { planEnd: "2026-11-20", cards: [entry("TB-3")] })],
      board({ "TB-3": closed }),
      1,
      TODAY,
    );
    expect(result[0]).toMatchObject({ eta: TODAY, lag: -7 });
  });
});

describe("etaPatch (2-day step)", () => {
  it("writes a new eta, a move of 2 days or more, and nothing else", () => {
    expect(etaPatch({}, "2026-11-20")).toEqual({ eta: "2026-11-20" });
    expect(etaPatch({ eta: "2026-11-20" }, "2026-11-21")).toEqual({});
    expect(etaPatch({ eta: "2026-11-20" }, "2026-11-19")).toEqual({});
    expect(etaPatch({ eta: "2026-11-20" }, "2026-11-22")).toEqual({
      eta: "2026-11-22",
    });
    expect(etaPatch({ eta: "2026-11-20" }, "2026-11-18")).toEqual({
      eta: "2026-11-18",
    });
  });

  it("removes an eta without a forecast and leaves a row without one", () => {
    expect(etaPatch({ eta: "2026-11-20" }, null)).toEqual({ eta: null });
    expect(etaPatch({}, null)).toEqual({});
  });
});
