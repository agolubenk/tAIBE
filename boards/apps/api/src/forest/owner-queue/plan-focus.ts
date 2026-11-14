import { rankRows } from "./plan-eta";
import { focusItemData, focusItemId } from "./plan-focus-item";
import { INPUT_MS, inputsRowId, type Named } from "./plan-inputs";
import { refreshOffPlan } from "./plan-off-plan";
import {
  type BoardCard,
  cardRef,
  cardUid,
  isOffPlanRow,
  type PlanRow,
  type RecentCard,
  rowProduct,
} from "./plan-types";
import type { QueueDoc } from "./queue-client";

// TB-107: the owner's inputs go into the plan and to the front. work/focus-<P>
// keeps the order the lanes take rows in (eval/tools/queue_focus.py rank_rows:
// the focus rows first, then planStart); the owner gets one item on a day
// with a move, «вернуть» puts the order back, silence is consent.

export type FocusMove = {
  row: string;
  from: number | null;
  to: number;
  why: string;
};
export type FocusDay = {
  date: string;
  moved: FocusMove[];
  item: string;
  // The order and the card keys the item offered (docs of this server).
  rows?: string[];
  keys?: string[];
  applied?: boolean;
};
// After «вернуть» the same inputs move nothing: only an input that arrived
// after `at` puts a row to the front.
export type Reverted = {
  at: string;
  rows: string[];
  keys: string[];
  item: string;
};
export type FocusDoc = {
  kind: "focus";
  rows: string[];
  prev: string[];
  at: string;
  day?: FocusDay;
  reverted?: Reverted;
};

export type FocusPlan = {
  product: string;
  // The inputs row's cards when they changed.
  inputs: { id: string; cards: unknown[] } | null;
  // version 0 — the doc is new.
  focus: { id: string; version: number; data: FocusDoc } | null;
  // Only on a day with a move.
  item: { id: string; data: Record<string, unknown> } | null;
  // The last day's item, unanswered: archived before the new one.
  archive: string | null;
};

const ROWS_MAX = 60;
const MOVED_MAX = 10;
const KEYS_MAX = 40;
const DOC_BYTES = 3000;

export const focusDocId = (product: string) => `focus-${product}`;

const ids = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
const same = (a: string[] | undefined, b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

export function readFocus(data: Record<string, unknown> | undefined) {
  if (!data || data.kind !== "focus" || !Array.isArray(data.rows)) return null;
  const day = data.day as FocusDay | undefined;
  const reverted = data.reverted as Reverted | undefined;
  return {
    kind: "focus",
    rows: ids(data.rows),
    prev: ids(data.prev),
    at: String(data.at ?? ""),
    ...(day && typeof day.item === "string" ? { day } : {}),
    ...(reverted && typeof reverted.at === "string" ? { reverted } : {}),
  } satisfies FocusDoc;
}

// The doc stays ≤ 3 KB: the old order goes first, then the keys and the
// moves, then the tail of the order (a row out of it ranks by planStart).
function fitted(doc: FocusDoc): FocusDoc {
  const next: FocusDoc = structuredClone(doc);
  const cuts: (() => boolean)[] = [
    () => next.prev.pop() !== undefined,
    () => next.day?.keys?.pop() !== undefined,
    () => next.reverted?.keys.pop() !== undefined,
    () => next.day?.moved.pop() !== undefined,
    () => next.rows.length > 1 && next.rows.pop() !== undefined,
  ];
  for (const cut of cuts) {
    while (JSON.stringify(next).length > DOC_BYTES && cut()) {}
  }
  return next;
}

// «Вернуть», once per item. A doc whose order is still the day's goes back
// to the order before it; a doc changed since (by hand, or a later run) keeps
// its rows. Either way the day's inputs move nothing again.
export function revertedDoc(
  doc: FocusDoc,
  day: FocusDay,
  answeredAt: string,
): FocusDoc {
  const ours = Array.isArray(day.rows);
  return fitted({
    ...doc,
    rows: ours && same(doc.rows, day.rows ?? []) ? doc.prev : doc.rows,
    day: { ...day, applied: true },
    reverted: {
      at: answeredAt,
      rows: ours ? (day.rows ?? []) : day.moved.map((move) => move.row),
      keys: (day.keys ?? []).slice(0, KEYS_MAX),
      item: day.item,
    },
  });
}

const uidsOf = (row: PlanRow) =>
  (Array.isArray(row.data.cards) ? row.data.cards : []).flatMap((entry) => {
    const ref = cardRef(entry);
    return ref ? [cardUid(ref.ws, ref.key)] : [];
  });

// Rows that entered the order or went up past another row.
function movesOf(
  prev: string[],
  rows: string[],
  why: (id: string) => string,
): FocusMove[] {
  const kept = prev.filter((id) => rows.includes(id));
  const before = new Map(kept.map((id, index) => [id, index]));
  const after = new Map(
    rows.filter((id) => before.has(id)).map((id, index) => [id, index]),
  );
  return rows
    .filter((id) => {
      const was = before.get(id);
      return was === undefined || (after.get(id) ?? was) < was;
    })
    .slice(0, MOVED_MAX)
    .map((row) => {
      const from = prev.indexOf(row);
      return {
        row,
        from: from < 0 ? null : from + 1,
        to: rows.indexOf(row) + 1,
        why: why(row).slice(0, 120),
      };
    });
}

type Input = {
  product: string;
  products: string[];
  // Plan rows (no kind, not archived) with this run's patches.
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  // The named cards that the board knows.
  cards: RecentCard[];
  named: Named;
  focusDoc: QueueDoc | undefined;
  url: string;
  today: string;
  now: Date;
};

// One product's daily step. The inputs row takes every named card that no
// other row holds (visibility). The order: the inputs row, then the rows that
// hold a named card or are named, in the current order (the last focus, then
// planStart, order, id). After «вернуть» only inputs that came later move a
// row, in front of the owner's order. The other rows are not stored: storing
// them would freeze a new row behind the old ones.
export function focusPlan(input: Input): FocusPlan | { missing: string } {
  const inputsId = inputsRowId(input.product);
  const inputsRow = input.rows.find((row) => row.id === inputsId);
  if (!inputsRow) return { missing: inputsId };
  const mine = input.cards.filter((card) => card.product === input.product);
  const board = new Map(input.board);
  for (const card of mine) board.set(cardUid(card.ws, card.key), card);
  const planned = new Set(
    input.rows
      .filter((row) => row.id !== inputsId && !isOffPlanRow(row.id))
      .flatMap(uidsOf),
  );
  const before = Array.isArray(inputsRow.data.cards)
    ? inputsRow.data.cards
    : [];
  const cards = refreshOffPlan({
    cards: before,
    board,
    planned,
    recent: mine,
    now: input.now,
  });
  const doc = readFocus(input.focusDoc?.data);
  const prev = doc?.rows ?? [];
  const revertAt = doc?.reverted ? Date.parse(doc.reverted.at) : Number.NaN;
  const reverted = input.now.getTime() - revertAt < INPUT_MS;
  const fresh = (at: number | undefined) =>
    at !== undefined && (!reverted || at > revertAt);
  const freshCards = new Map(
    mine
      .filter((card) => fresh(input.named.keys.get(card.key)))
      .map((card) => [cardUid(card.ws, card.key), card.key]),
  );
  const named = (row: PlanRow) =>
    fresh(input.named.rows.get(row.id)) ||
    uidsOf(row).some((uid) => freshCards.has(uid));
  const front = rankRows(
    input.rows.filter(
      (row) =>
        row.id !== inputsId &&
        rowProduct(row.id, input.products) === input.product &&
        row.data.status !== "done" &&
        named(row),
    ),
    prev,
  );
  const inputsFirst =
    !reverted || named({ ...inputsRow, data: { ...inputsRow.data, cards } });
  const rows = [
    ...new Set([
      ...(inputsFirst ? [inputsId] : []),
      ...front.map((row) => row.id),
      ...(reverted ? prev : []),
    ]),
  ].slice(0, ROWS_MAX);
  const plan: FocusPlan = {
    product: input.product,
    inputs:
      JSON.stringify(cards) === JSON.stringify(before)
        ? null
        : { id: inputsId, cards },
    focus: null,
    item: null,
    archive: null,
  };
  if (same(prev, rows)) return plan;
  const focus = {
    id: focusDocId(input.product),
    version: input.focusDoc?.version ?? 0,
  };
  const why = (id: string) => {
    if (id === inputsId) return "ваши вбросы за 7 дней";
    const row = input.rows.find((one) => one.id === id);
    const keys = row
      ? uidsOf(row).flatMap((uid) => freshCards.get(uid) ?? [])
      : [];
    return keys.length > 0 ? `названы: ${keys.join(", ")}` : "строка названа";
  };
  const moved = movesOf(prev, rows, why);
  // A row that left the order moves nothing: the doc follows, no item.
  if (moved.length === 0) {
    const base: FocusDoc = doc ?? { kind: "focus", rows, prev: [], at: "" };
    plan.focus = {
      ...focus,
      data: fitted({ ...base, rows, at: input.now.toISOString() }),
    };
    return plan;
  }
  const itemId = focusItemId(input.product, input.today);
  const day = doc?.day;
  plan.archive = day && !day.applied && day.item !== itemId ? day.item : null;
  plan.item = {
    id: itemId,
    data: focusItemData({
      product: input.product,
      inputsTitle: String(inputsRow.data.title ?? inputsId),
      inputsFirst,
      cards,
      board,
      frontTitles: front.map((row) => String(row.data.title ?? row.id)),
      url: input.url,
      today: input.today,
    }),
  };
  plan.focus = {
    ...focus,
    data: fitted({
      kind: "focus",
      rows,
      prev,
      at: input.now.toISOString(),
      day: {
        date: input.today,
        moved,
        item: itemId,
        rows,
        keys: [...new Set(freshCards.values())].slice(0, KEYS_MAX),
      },
      ...(doc?.reverted ? { reverted: doc.reverted } : {}),
    }),
  };
  return plan;
}
