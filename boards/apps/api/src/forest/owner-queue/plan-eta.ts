import {
  ACTIVE_STATUSES,
  addDays,
  type BoardCard,
  cardRef,
  cardUid,
  daysBetween,
  isOffPlanRow,
  type PlanRow,
  rowProduct,
} from "./plan-types";

// F7.1: the pace is the cards closed in the last 14 days; under 5 is «мало
// данных» — no forecast.
export const PACE_DAYS = 14;
const PACE_MIN = 5;
// eta moves only by this much: a daily ±1 would bump row versions under the
// agents' ifVersion (resources review).
const ETA_STEP_DAYS = 2;

export const pace = (closed: number) =>
  closed < PACE_MIN ? null : closed / PACE_DAYS;

// An open card of a forecast row, for the cut list.
export type OpenCard = {
  key: string;
  bug: boolean;
  // A bug's severity or a task's priority, as cards[].s.
  level: string;
  active: boolean;
};

export type RowForecast = {
  id: string;
  title: string;
  planEnd: string;
  eta: string;
  lag: number;
  open: OpenCard[];
};

const resolved = (row: PlanRow, board: ReadonlyMap<string, BoardCard>) =>
  (Array.isArray(row.data.cards) ? row.data.cards : []).some((entry) => {
    const ref = cardRef(entry);
    return ref !== null && board.has(cardUid(ref.ws, ref.key));
  });

// The rows of product P that get a forecast: agent rows with a term and at
// least one card the board knows. rows are plan rows (no kind, not archived).
export function forecastRows(
  rows: PlanRow[],
  product: string,
  products: string[],
  board: ReadonlyMap<string, BoardCard>,
): PlanRow[] {
  return rows.filter(
    (row) =>
      rowProduct(row.id, products) === product &&
      !isOffPlanRow(row.id) &&
      row.data.status !== "done" &&
      row.data.status !== "blocked" &&
      row.data.who !== "owner" &&
      typeof row.data.planEnd === "string" &&
      resolved(row, board),
  );
}

// The focus doc's order first (TB-107), then planStart (none — last), order,
// id: eval/tools/queue_focus.py rank_rows.
export function rankRows(rows: PlanRow[], focus: string[]): PlanRow[] {
  const at = new Map(focus.map((id, index) => [id, index]));
  const num = (value: unknown) =>
    typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
  const start = (row: PlanRow) =>
    typeof row.data.planStart === "string" ? row.data.planStart : "9999-12-31";
  return [...rows].sort(
    (a, b) =>
      (at.get(a.id) ?? at.size) - (at.get(b.id) ?? at.size) ||
      start(a).localeCompare(start(b)) ||
      num(a.data.order) - num(b.data.order) ||
      a.id.localeCompare(b.id),
  );
}

// Ranked rows one after another at the product's pace: a row ends when the
// open cards of it and of every row before it are closed. A card of two rows
// counts in the first.
export function forecast(
  ranked: PlanRow[],
  board: ReadonlyMap<string, BoardCard>,
  perDay: number,
  today: string,
): RowForecast[] {
  const counted = new Set<string>();
  let cumulative = 0;
  return ranked.map((row) => {
    const open: OpenCard[] = [];
    for (const entry of Array.isArray(row.data.cards) ? row.data.cards : []) {
      const ref = cardRef(entry);
      const uid = ref ? cardUid(ref.ws, ref.key) : "";
      const card = uid ? board.get(uid) : undefined;
      if (!ref || !card || card.final || counted.has(uid)) continue;
      counted.add(uid);
      const fields = entry as Record<string, unknown>;
      open.push({
        key: ref.key,
        bug: fields.k === "bug",
        level: typeof fields.s === "string" ? fields.s : "",
        active: ACTIVE_STATUSES.has(card.status),
      });
    }
    cumulative += open.length;
    const eta = addDays(today, Math.ceil(cumulative / perDay));
    const planEnd = String(row.data.planEnd).slice(0, 10);
    return {
      id: row.id,
      title: typeof row.data.title === "string" ? row.data.title : row.id,
      planEnd,
      eta,
      lag: daysBetween(planEnd, eta),
      open,
    };
  });
}

// The eta field to write: a new forecast, a move of 2 days or more, or none
// (null removes it). {} — keep.
export function etaPatch(
  data: Record<string, unknown>,
  eta: string | null,
): Record<string, unknown> {
  const current = typeof data.eta === "string" ? data.eta : null;
  if (eta === null) return current === null ? {} : { eta: null };
  if (current === null) return { eta };
  return Math.abs(daysBetween(current, eta)) >= ETA_STEP_DAYS ? { eta } : {};
}
