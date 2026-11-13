import { describe, expect, it } from "vite-plus/test";
import { type FocusDoc, focusPlan, revertedDoc } from "./plan-focus";
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
}) {
  return focusPlan({
    product: input.product ?? "hr-helper",
    products: ["hr-helper", "taibe"],
    rows: input.rows ?? ROWS,
    board: new Map(input.board ?? []),
    cards: input.cards ?? [],
    named: input.named,
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
      doc: { kind: "focus", rows: ["w-n-b"], prev: [], at: "" },
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual([
      "w-n-inputs",
      "w-n-b",
      "w-n-a",
      "w-n-c",
    ]);
    expect(result.focus?.data.prev).toEqual(["w-n-b"]);
    expect(result.focus?.version).toBe(3);
    expect(result.focus?.data.day).toMatchObject({
      date: TODAY,
      item: "d-hr-focus-20261114",
      rows: ["w-n-inputs", "w-n-b", "w-n-a", "w-n-c"],
      keys: ["APP-1", "APP-2", "APP-9"],
    });
    expect(result.item?.data).toMatchObject({
      kind: "decision",
      options: [{ id: "revert", label: "Вернуть прежний порядок" }],
      chips: [["молчание = согласны", ""]],
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
      doc: { kind: "focus", rows: ["w-n-inputs", "w-n-a"], prev: [], at: "" },
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
        prev: [],
        at: "",
        day: { date: "2026-11-13", moved: [], item: "d-hr-focus-20261113" },
      },
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.archive).toBe("d-hr-focus-20261113");
    expect(result.item?.id).toBe("d-hr-focus-20261114");
  });
});

describe("after «вернуть» (TB-107)", () => {
  const day = {
    date: "2026-11-13",
    moved: [{ row: "w-n-inputs", from: null, to: 1, why: "вбросы" }],
    item: "d-hr-focus-20261113",
    rows: ["w-n-inputs", "w-n-a"],
    keys: ["APP-1", "APP-9"],
  };
  const doc: FocusDoc = {
    kind: "focus",
    rows: day.rows,
    prev: [],
    at: "",
    day,
  };
  const back = revertedDoc(doc, day, REVERT);

  it("puts the order back once and keeps the day's rows and keys", () => {
    expect(back).toMatchObject({
      rows: [],
      prev: [],
      day: { applied: true },
      reverted: {
        at: REVERT,
        rows: ["w-n-inputs", "w-n-a"],
        keys: ["APP-1", "APP-9"],
        item: "d-hr-focus-20261113",
      },
    });
  });

  it("keeps an order changed by hand", () => {
    const legacy = {
      date: "2026-11-13",
      moved: [{ row: "w-n-inputs", from: 1, to: 0, why: "владелец: revert" }],
      item: "d-hr-focus-1311",
    };
    const done = revertedDoc(
      { kind: "focus", rows: [], prev: ["w-n-inputs"], at: "", day: legacy },
      legacy,
      REVERT,
    );
    expect(done.rows).toEqual([]);
    expect(done.reverted).toMatchObject({ rows: ["w-n-inputs"], keys: [] });
  });

  it("the same inputs next day give no move and no item, cards still go in", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-9")],
      named: named([
        ["APP-1", T1],
        ["APP-9", T1],
      ]),
      doc: back,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus).toBeNull();
    expect(result.item).toBeNull();
    expect(keysOf(result.inputs?.cards)).toEqual(["APP-9"]);
  });

  it("a new input after the revert moves its row in front of the owner's order", () => {
    const result = plan({
      cards: [card("APP-1"), card("APP-2")],
      named: named([
        ["APP-1", T1],
        ["APP-2", T2],
      ]),
      doc: { ...back, rows: ["w-n-c"] },
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual(["w-n-b", "w-n-c"]);
    expect(result.focus?.data.reverted?.at).toBe(REVERT);
    expect(result.item?.id).toBe("d-hr-focus-20261114");
  });

  it("a new card without a row after the revert puts the inputs row first", () => {
    const result = plan({
      cards: [card("APP-9")],
      named: named([["APP-9", T2]]),
      doc: back,
    });
    if ("missing" in result) throw new Error("no inputs row");
    expect(result.focus?.data.rows).toEqual(["w-n-inputs"]);
  });
});
