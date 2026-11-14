import { describe, expect, it } from "vite-plus/test";
import { type FocusDoc, focusPlan, readFocus, revertedDoc } from "./plan-focus";
import { type ItemFocus, readItemFocus } from "./plan-focus-item";
import type { Named } from "./plan-inputs";
import type { BoardCard, PlanRow, RecentCard } from "./plan-types";
import type { QueueDoc } from "./queue-client";

const WS = "hr-helper-lavaeon";
const NOW = new Date("2026-11-14T06:00:00Z");
const TODAY = "2026-11-14";
const T1 = Date.parse("2026-11-13T09:00:00Z");
const REVERT = "2026-11-13T12:00:00Z";
const T2 = Date.parse("2026-11-13T15:00:00Z");

const entry = (key: string, st = "to-do") => ({
  key,
  ws: WS,
  t: `title ${key}`,
  k: "task",
  s: "P2",
  st,
});
const row = (id: string, data: Record<string, unknown>): PlanRow => ({
  id,
  version: 1,
  data: { status: "planned", who: "agent", cards: [], ...data },
});
const card = (key: string, extra: Partial<RecentCard> = {}): RecentCard => ({
  ws: WS,
  key,
  product: "hr-helper",
  title: `title ${key}`,
  bug: false,
  level: "P2",
  status: "to-do",
  final: false,
  closedAt: null,
  ...extra,
});
const named = (keys: [string, number][], rows: [string, number][] = []) =>
  ({ keys: new Map(keys), rows: new Map(rows) }) satisfies Named;
const focusDoc = (data: FocusDoc): QueueDoc => ({
  id: "focus-hr-helper",
  data,
  version: 3,
  updatedAt: 0,
});

const ROWS = [
  row("w-n-inputs", { title: "Ваши вбросы", status: "doing" }),
  row("w-n-a", {
    title: "A",
    planStart: "2026-11-01",
    cards: [entry("APP-1")],
  }),
  row("w-n-b", {
    title: "B",
    planStart: "2026-11-05",
    cards: [entry("APP-2")],
  }),
  row("w-n-c", {
    title: "C",
    planStart: "2026-11-02",
    cards: [entry("APP-3")],
  }),
  row("w-taibe-x", { cards: [entry("TB-1")] }),
];

function plan(input: {
  rows?: PlanRow[];
  cards?: RecentCard[];
  named: Named;
  doc?: FocusDoc;
  board?: [string, BoardCard][];
  product?: string;
  revertAt?: number;
}) {
  return focusPlan({
    product: input.product ?? "hr-helper",
    products: ["hr-helper", "taibe"],
    rows: input.rows ?? ROWS,
    board: new Map(input.board ?? []),
    cards: input.cards ?? [],
    named: input.named,
    revertAt: input.revertAt,
    focusDoc: input.doc ? focusDoc(input.doc) : undefined,
    url: "https://ops.test",
    today: TODAY,
    now: NOW,
  });
}
const keysOf = (cards: unknown[] | undefined) =>
  (cards ?? []).map((one) => (one as { key: string }).key);

describe("focusPlan (TB-107)", () => {
  it("skips a product without its inputs row and creates no row", () => {
    expect(plan({ product: "taibe", named: named([]) })).toEqual({
      missing: "w-taibe-inputs",
    });
  });

  it("puts named cards without a row into the inputs row, one entry each", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-9"), card("APP-9")],
      named: named([
        ["APP-1", T1],
        ["APP-9", T1],
      ]),
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(keysOf(result.inputs?.cards)).toEqual(["APP-9"]);
  });

  it("removes a card closed more than 14 days ago or now held by another row", () => {
    const rows = ROWS.map((one) =>
      one.id === "w-n-inputs"
        ? {
            ...one,
            data: {
              ...one.data,
              cards: [entry("APP-5", "done"), entry("APP-1"), entry("APP-8")],
            },
          }
        : one,
    );
    const result = plan({
      rows,
      named: named([]),
      board: [
        [
          `${WS}/APP-5`,
          {
            status: "done",
            final: true,
            closedAt: new Date("2026-10-20T00:00:00Z"),
          },
        ],
        [`${WS}/APP-8`, { status: "to-do", final: false, closedAt: null }],
      ],
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(keysOf(result.inputs?.cards)).toEqual(["APP-8"]);
  });

  it("puts the inputs row first, then rows with named cards in the current order", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-2"), card("APP-9")],
      named: named(
        [
          ["APP-1", T1],
          ["APP-2", T1],
          ["APP-9", T1],
        ],
        [["w-n-c", T1]],
      ),
      doc: { kind: "focus", rows: ["w-n-b"], at: "" },
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual([
      "w-n-inputs",
      "w-n-b",
      "w-n-a",
      "w-n-c",
    ]);
    expect(result.focus?.version).toBe(3);
    // The doc only points to the day's item; the orders are in the item.
    expect(result.focus?.data).toEqual({
      kind: "focus",
      rows: ["w-n-inputs", "w-n-b", "w-n-a", "w-n-c"],
      at: NOW.toISOString(),
      day: {
        date: TODAY,
        moved: expect.any(Array),
        item: "d-hr-focus-20261114",
      },
    });
    expect(result.item?.data).toMatchObject({
      kind: "decision",
      source: "t-boards (TB-107)",
      options: [{ id: "revert", label: "Вернуть прежний порядок" }],
      chips: [["молчание = согласны", ""]],
      focus: {
        rows: ["w-n-inputs", "w-n-b", "w-n-a", "w-n-c"],
        prev: ["w-n-b"],
        keys: ["APP-1", "APP-2", "APP-9"],
      },
    });
    expect(String(result.item?.data.title)).toContain(
      "1 карточка: 0 сделаны, 0 на ревью, 1 ждут",
    );
  });

  it("writes nothing when the order and the inputs row are unchanged", () => {
    const rows = ROWS.map((one) =>
      one.id === "w-n-inputs"
        ? { ...one, data: { ...one.data, cards: [entry("APP-9")] } }
        : one,
    );
    const result = plan({
      rows,
      cards: [card("APP-1"), card("APP-9")],
      named: named([
        ["APP-1", T1],
        ["APP-9", T1],
      ]),
      doc: { kind: "focus", rows: ["w-n-inputs", "w-n-a"], at: "" },
    });
    expect(result).toEqual({
      product: "hr-helper",
      inputs: null,
      focus: null,
      item: null,
      archive: null,
    });
  });

  it("archives the last day's unanswered item with a new move", () => {
    const result = plan({
      cards: [card("APP-2")],
      named: named([["APP-2", T1]]),
      doc: {
        kind: "focus",
        rows: ["w-n-inputs"],
        at: "",
        day: { date: "2026-11-13", moved: [], item: "d-hr-focus-20261113" },
      },
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.archive).toBe("d-hr-focus-20261113");
    expect(result.item?.id).toBe("d-hr-focus-20261114");
  });
});

describe("readItemFocus (TB-107)", () => {
  const offered = () => {
    const result = plan({
      cards: [card("APP-2")],
      named: named([["APP-2", T1]]),
    });
    if ("missing" in result || !result.item) throw new Error("no item");
    return {
      id: result.item.id,
      data: result.item.data,
      version: 1,
      updatedAt: 0,
    };
  };

  it("reads the order the item offered", () => {
    expect(readItemFocus(offered(), "hr-helper")).toEqual({
      rows: ["w-n-inputs", "w-n-b"],
      prev: [],
      keys: ["APP-2"],
    });
  });

  it("refuses an item of another product, another source or a broken one", () => {
    const item = offered();
    expect(readItemFocus(item, "taibe")).toBeNull();
    expect(
      readItemFocus(
        { ...item, data: { ...item.data, source: "agent" } },
        "hr-helper",
      ),
    ).toBeNull();
    expect(
      readItemFocus(
        {
          ...item,
          data: { ...item.data, focus: { rows: [1], prev: [], keys: [] } },
        },
        "hr-helper",
      ),
    ).toBeNull();
    expect(readItemFocus(null, "hr-helper")).toBeNull();
  });
});

describe("after «вернуть» (TB-107)", () => {
  const day = {
    date: "2026-11-13",
    moved: [{ row: "w-n-inputs", from: null, to: 1, why: "вбросы" }],
    item: "d-hr-focus-20261113",
  };
  // The item's order before the day; w-taibe-x is another product's row and
  // w-n-gone is no open plan row.
  const offered: ItemFocus = {
    rows: ["w-n-inputs", "w-n-a"],
    prev: ["w-n-c", "w-taibe-x", "w-n-gone"],
    keys: ["APP-1", "APP-9"],
  };
  const own = new Set(["w-n-inputs", "w-n-a", "w-n-b", "w-n-c"]);
  const doc: FocusDoc = { kind: "focus", rows: offered.rows, at: "", day };
  const back = revertedDoc(doc, day, offered, own);
  const revertAt = Date.parse(REVERT);

  it("puts the item's order back once, only the product's open rows", () => {
    expect(back).toEqual({
      kind: "focus",
      rows: ["w-n-c"],
      at: "",
      day: { ...day, applied: true },
    });
  });

  it("keeps an order changed since, and restores nothing without the item's order", () => {
    expect(
      revertedDoc({ ...doc, rows: ["w-n-b"] }, day, offered, own).rows,
    ).toEqual(["w-n-b"]);
    const closed = revertedDoc(doc, day, null, own);
    expect(closed.rows).toEqual(offered.rows);
    expect(closed.day?.applied).toBe(true);
  });

  it("reads no prev and no reverted from an older doc", () => {
    expect(
      readFocus({
        kind: "focus",
        rows: ["w-n-a"],
        prev: ["w-taibe-x"],
        at: "",
        reverted: { at: NOW.toISOString(), rows: [], keys: [], item: "x" },
        day: { ...day, rows: ["w-n-b"], keys: ["APP-1"] },
      }),
    ).toEqual({ kind: "focus", rows: ["w-n-a"], at: "", day });
  });

  it("the same inputs next day give no move and no item, cards still go in", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-9")],
      named: named([
        ["APP-1", T1],
        ["APP-9", T1],
      ]),
      doc: back,
      revertAt,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus).toBeNull();
    expect(result.item).toBeNull();
    expect(keysOf(result.inputs?.cards)).toEqual(["APP-9"]);
  });

  it("without the owner's revert the same inputs move the rows again", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-9")],
      named: named([
        ["APP-1", T1],
        ["APP-9", T1],
      ]),
      doc: back,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual(["w-n-inputs", "w-n-a"]);
    expect(result.item?.id).toBe("d-hr-focus-20261114");
  });

  it("a new input after the revert moves its row in front of the owner's order", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-2")],
      named: named([
        ["APP-1", T1],
        ["APP-2", T2],
      ]),
      doc: back,
      revertAt,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual(["w-n-b", "w-n-c"]);
    expect(result.item?.id).toBe("d-hr-focus-20261114");
    expect(result.item?.data.focus).toMatchObject({ prev: ["w-n-c"] });
  });

  it("a new card without a row after the revert puts the inputs row first", () => {
    const result = plan({
      cards: [card("APP-9")],
      named: named([["APP-9", T2]]),
      doc: { ...back, rows: [] },
      revertAt,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual(["w-n-inputs"]);
  });
});
