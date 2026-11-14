import { describe, expect, it } from "vite-plus/test";
import {
  cutList,
  type DueRow,
  type DueState,
  dueItemData,
  dueItemId,
  dueRows,
  needsDecision,
} from "./plan-due";
import type { OpenCard, RowForecast } from "./plan-eta";

const card = (key: string, extra: Partial<OpenCard> = {}): OpenCard => ({
  key,
  bug: false,
  level: "P2",
  active: false,
  ...extra,
});
const late = (id: string, lag: number, cut: string[] = []): DueRow => ({
  id,
  planEnd: "2026-11-14",
  eta: "2026-11-20",
  lag,
  cut,
});
const state = (rows: DueRow[], extra: Partial<DueState> = {}): DueState => ({
  kind: "due",
  item: "d-taibe-due-20261112",
  at: "2026-11-12T06:00:00.000Z",
  rows,
  applied: false,
  ...extra,
});

describe("cutList (the row's tail by the board's law)", () => {
  it("takes tasks before bugs, lower priority first, never a card in work", () => {
    const open = [
      card("TB-1", { bug: true, level: "low" }),
      card("TB-2", { level: "P0" }),
      card("TB-3", { level: "P3" }),
      card("TB-4", { level: "P3", active: true }),
      card("TB-5", { level: "P1" }),
      card("TB-6", { level: "" }),
    ];
    // ceil(2 days × 1.2 a day) = 3 cards.
    expect(cutList(open, 2, 1.2)).toEqual(["TB-6", "TB-3", "TB-5"]);
    expect(cutList(open, 30, 1)).toEqual([
      "TB-6",
      "TB-3",
      "TB-5",
      "TB-2",
      "TB-1",
    ]);
  });
});

describe("dueRows", () => {
  const forecastRow = (
    id: string,
    lag: number,
    open: OpenCard[],
  ): RowForecast => ({
    id,
    title: id,
    planEnd: "2026-11-14",
    eta: "2026-11-20",
    lag,
    open,
  });

  it("keeps late rows with work left and their cut", () => {
    const rows = dueRows(
      [
        forecastRow("w-a", 2, [card("TB-1"), card("TB-2")]),
        forecastRow("w-b", 0, [card("TB-3")]),
        forecastRow("w-c", 3, []),
      ],
      0.5,
    );
    expect(rows).toEqual([
      {
        id: "w-a",
        planEnd: "2026-11-14",
        eta: "2026-11-20",
        lag: 2,
        cut: ["TB-2"],
      },
    ]);
  });
});

describe("needsDecision (F7.2)", () => {
  it("asks when rows are late and nothing was asked", () => {
    expect(needsDecision(null, [late("w-a", 3)])).toBe(true);
    expect(needsDecision(null, [])).toBe(false);
  });

  it("does not repeat an unchanged set, answered or not", () => {
    const prev = state([late("w-a", 3), late("w-b", 1)]);
    expect(needsDecision(prev, [late("w-b", 2), late("w-a", 4)])).toBe(false);
    expect(
      needsDecision({ ...prev, applied: true, choice: "red" }, [
        late("w-a", 3),
        late("w-b", 1),
      ]),
    ).toBe(false);
  });

  it("asks again on a changed set or a lag grown by 2 days", () => {
    const prev = state([late("w-a", 3), late("w-b", 1)]);
    expect(needsDecision(prev, [late("w-a", 3)])).toBe(true);
    expect(needsDecision(prev, [late("w-a", 3), late("w-c", 1)])).toBe(true);
    expect(needsDecision(prev, [late("w-a", 5), late("w-b", 1)])).toBe(true);
  });
});

describe("dueItemData", () => {
  it("is a decision with the late rows, keep first and recommended", () => {
    const data = dueItemData({
      product: "taibe",
      closed: 21,
      perDay: 1.5,
      late: [late("w-a", 3, ["TB-6", "TB-3"]), late("w-b", 1)],
      titles: new Map([["w-a", "Строка A"]]),
      today: "2026-11-13",
    });
    expect(dueItemId("taibe", "2026-11-13")).toBe("d-taibe-due-20261113");
    expect(data).toMatchObject({
      kind: "decision",
      title: "Сроки taibe: 2 строк не успевают по текущему темпу",
      rows: ["w-a", "w-b"],
      added: "2026-11-13",
      source: "t-boards (TB-112)",
      options: [
        { id: "keep", hint: "рекомендую" },
        { id: "move" },
        { id: "red" },
      ],
    });
    expect(String(data.body)).toContain(
      "- Строка A — срок 14.11, прогноз 20.11, опаздывает на 3 дн.; держать срок — в бэклог: TB-6, TB-3",
    );
    expect(String(data.body)).toContain("Темп: 1.5 карточки в день");
  });
});
