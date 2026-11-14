import { rankRows } from "./plan-eta";
import { focusItemData, focusItemId, type ItemFocus } from "./plan-focus-item";
import {
  INPUT_MS,
  inputsRowId,
  type Named,
  namedAt,
  sharedKeys,
} from "./plan-inputs";
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
// with a move, «вернуть» puts the order back, silence is consent. The agents
// write the work collection, so the doc holds no state the owner's answer
// depends on: the order before the day and the offered order live in the
// day's item (plan-focus-item.ts), the revert time is the ownerAt of the
// owner's «Вернуть» (plan-focus-run.ts ownerReverts).

export type FocusMove = {
  row: string;
  from: number | null;
  to: number;
  why: string;
};
// item — the day's decision; applied — the owner's answer on it is handled.
export type FocusDay = {
  date: string;
  moved: FocusMove[];
  item: string;
  applied?: boolean;
};
export type FocusDoc = {
  kind: "focus";
  rows: string[];
  at: string;
  day?: FocusDay;
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

// Only the fields this module reads; an older doc's prev and reverted are
// dropped at the next write.
export function readFocus(data: Record<string, unknown> | undefined) {
  if (!data || data.kind !== "focus" || !Array.isArray(data.rows)) return null;
  const day = data.day as Record<string, unknown> | undefined;
  return {
    kind: "focus",
    rows: ids(data.rows).slice(0, ROWS_MAX),
    at: String(data.at ?? ""),
    ...(day && typeof day.item === "string"
      ? {
          day: {
            date: typeof day.date === "string" ? day.date : "",
            moved: Array.isArray(day.moved) ? (day.moved as FocusMove[]) : [],
            item: day.item,
            ...(day.applied === true ? { applied: true } : {}),
          },
        }
      : {}),
  } satisfies FocusDoc;
}

// The doc stays ≤ 3 KB: the moves go first, then the tail of the order (a
// row out of it ranks by planStart).
function fitted(doc: FocusDoc): FocusDoc {
  const next: FocusDoc = structuredClone(doc);
  const cuts: (() => boolean)[] = [
    () => next.day?.moved.pop() !== undefined,
    () => next.rows.length > 1 && next.rows.pop() !== undefined,
  ];
  for (const cut of cuts) {
    while (JSON.stringify(next).length > DOC_BYTES && cut()) {}
  }
  return next;
}

// The owner's answer on the day's item, once. offered — what the item offered
// when the owner answered it; null — nothing to restore (the item is not a
// focus item of this server, archived, missing, or changed after the answer).
// A doc whose order is still the offered one goes back to the item's order
// before it, kept to the open plan rows of the product (own); a doc changed
// since (by hand, or a later run) keeps its rows.
export function revertedDoc(
  doc: FocusDoc,
  day: FocusDay,
  offered: ItemFocus | null,
  own: ReadonlySet<string>,
): FocusDoc {
  const back =
    offered && same(doc.rows, offered.rows)
      ? offered.prev.filter((id) => own.has(id)).slice(0, ROWS_MAX)
      : doc.rows;
  return fitted({ ...doc, rows: back, day: { ...day, applied: true } });
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
  // The named cards that the board knows, of every product.
  cards: RecentCard[];
  named: Named;
  // When the owner last pressed «Вернуть» on a focus item of this product, in
  // the last 7 days (ms): the owner's answer, never the doc.
  revertAt: number | undefined;
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
  // A key on the cards of 2+ products is this product's input only from a
  // text on this product's item (namedAt): neither its row nor its order.
  const shared = sharedKeys(input.cards);
  const namedOf = (key: string) =>
    namedAt(input.named, shared, input.product, key);
  const mine = input.cards.filter(
    (card) => card.product === input.product && namedOf(card.key) !== undefined,
  );
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
  const revertAt = input.revertAt ?? Number.NaN;
  const reverted = input.now.getTime() - revertAt < INPUT_MS;
  const fresh = (at: number | undefined) =>
    at !== undefined && (!reverted || at > revertAt);
  const freshCards = new Map(
    mine
      .filter((card) => fresh(namedOf(card.key)))
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
    const base: FocusDoc = doc ?? { kind: "focus", rows, at: "" };
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
      offered: {
        rows,
        prev: prev.slice(0, ROWS_MAX),
        keys: [...new Set(freshCards.values())].slice(0, KEYS_MAX),
      },
    }),
  };
  plan.focus = {
    ...focus,
    data: fitted({
      kind: "focus",
      rows,
      at: input.now.toISOString(),
      day: { date: input.today, moved, item: itemId },
    }),
  };
  return plan;
}
