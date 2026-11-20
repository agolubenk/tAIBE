import {
  type DueChoice,
  type DueState,
  dueItemData,
  dueItemId,
  dueRows,
  dueStateId,
  needsDecision,
  readState,
} from "./plan-due";
import { etaPatch, forecast, forecastRows, pace, rankRows } from "./plan-eta";
import { type BoardCard, type PlanRow, rowProduct } from "./plan-types";
import type { QueueDoc } from "./queue-client";

export type Decision = {
  product: string;
  item: { id: string; data: Record<string, unknown> };
  // The last decision, unanswered: archived before the new one.
  archive: string | null;
  // version 0 — the state doc is new.
  state: { id: string; data: DueState; version: number };
};

export type DailyPlan = {
  // Row id → the eta field to write.
  eta: Map<string, Record<string, unknown>>;
  decisions: Decision[];
};

const focusOf = (docs: QueueDoc[], product: string): string[] => {
  const rows = docs.find((doc) => doc.id === `focus-${product}`)?.data.rows;
  return Array.isArray(rows)
    ? rows.filter((id): id is string => typeof id === "string")
    : [];
};

function decide(input: {
  product: string;
  docs: QueueDoc[];
  forecastRows: ReturnType<typeof forecast>;
  closed: number;
  perDay: number;
  open: DueChoice | null | undefined;
  today: string;
  now: Date;
}): Decision | null {
  // An answer not applied yet goes first: a new decision would replace it.
  if (input.open) return null;
  const late = dueRows(input.forecastRows, input.perDay);
  const stateDoc = input.docs.find(
    (doc) => doc.id === dueStateId(input.product),
  );
  const prev = readState(stateDoc?.data);
  if (!needsDecision(prev, late)) return null;
  const id = dueItemId(input.product, input.today);
  // Asked today already (a restart runs the day again).
  if (prev?.item === id) return null;
  const titles = new Map(input.forecastRows.map((row) => [row.id, row.title]));
  return {
    product: input.product,
    item: {
      id,
      data: dueItemData({
        product: input.product,
        closed: input.closed,
        perDay: input.perDay,
        late,
        titles,
        today: input.today,
      }),
    },
    archive: prev && !prev.applied ? prev.item : null,
    state: {
      id: dueStateId(input.product),
      version: stateDoc?.version ?? 0,
      data: {
        kind: "due",
        item: id,
        at: input.now.toISOString(),
        rows: late,
        applied: false,
      },
    },
  };
}

// Once a day (F7.1, F7.2): per plan product, the forecast of its rows in
// focus order at the pace of the last 14 days, the eta of each row, and one
// owner decision when rows miss their term. rows carry this run's patches.
export function dailyPlan(input: {
  docs: QueueDoc[];
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  closed: ReadonlyMap<string, number>;
  products: string[];
  open: ReadonlyMap<string, DueChoice | null>;
  today: string;
  now: Date;
}): DailyPlan {
  const plan: DailyPlan = { eta: new Map(), decisions: [] };
  const setEta = (row: PlanRow, eta: string | null) => {
    const patch = etaPatch(row.data, eta);
    if (Object.keys(patch).length > 0) plan.eta.set(row.id, patch);
  };
  for (const product of input.products) {
    const closed = input.closed.get(product) ?? 0;
    const perDay = pace(closed);
    const ranked =
      perDay === null
        ? []
        : rankRows(
            forecastRows(input.rows, product, input.products, input.board),
            focusOf(input.docs, product),
          );
    const rows =
      perDay === null ? [] : forecast(ranked, input.board, perDay, input.today);
    const etaOf = new Map(rows.map((row) => [row.id, row.eta]));
    // A row without a forecast («мало данных», done, blocked, no term) keeps
    // no eta: the page would show a stale lag.
    for (const row of input.rows) {
      if (rowProduct(row.id, input.products) !== product) continue;
      setEta(row, etaOf.get(row.id) ?? null);
    }
    if (perDay === null) continue;
    const decision = decide({
      product,
      docs: input.docs,
      forecastRows: rows,
      closed,
      perDay,
      open: input.open.get(product),
      today: input.today,
      now: input.now,
    });
    if (decision) plan.decisions.push(decision);
  }
  return plan;
}
