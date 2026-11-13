import { type OpenCard, PACE_DAYS, type RowForecast } from "./plan-eta";

// F7.2: one owner decision per product about the rows that miss their term.
// The decision item d-<P>-due-<date> is the source of truth: what the owner
// read is what the answer applies — rows, the move dates (moveTo, checked by
// the queue server, TB-112 part 1) and the cut cards (due). work/due-<P> (kind
// «due»: not a plan row, the page skips a doc without a title) only points to
// the open item and keeps the late rows for the next «ask again?» check.

export const DUE_CHOICES = ["keep", "move", "red"] as const;
export type DueChoice = (typeof DUE_CHOICES)[number];
export const isDueChoice = (value: unknown): value is DueChoice =>
  DUE_CHOICES.includes(value as DueChoice);

export type DueRow = {
  id: string;
  planEnd: string;
  eta: string;
  lag: number;
  // Keys of the open cards «держать срок» moves to the backlog row.
  cut: string[];
};

export type DueState = {
  kind: "due";
  item: string;
  at: string;
  rows: DueRow[];
  applied: boolean;
  appliedAt?: string;
  choice?: DueChoice;
  note?: string;
};

// The state doc stays small (≤ 3 KB): the first rows by rank, 10 cut keys each.
const STATE_BYTES = 3000;
const STATE_ROWS = 12;
const CUT_MAX = 10;
// A lag that grew this much since the last decision asks again.
const LAG_STEP_DAYS = 2;

export const dueStateId = (product: string) => `due-${product}`;
export const dueItemId = (product: string, today: string) =>
  `d-${product}-due-${today.replaceAll("-", "")}`;
// Every decision item of the product starts so (the queue server: DUE_REF).
export const dueItemPrefix = (product: string) => `d-${product}-due-`;
export const DUE_SOURCE = "t-boards (TB-112)";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDueRow = (row: unknown): row is DueRow => {
  if (!row || typeof row !== "object") return false;
  const one = row as Record<string, unknown>;
  return (
    typeof one.id === "string" &&
    typeof one.planEnd === "string" &&
    typeof one.eta === "string" &&
    DATE.test(one.eta) &&
    typeof one.lag === "number" &&
    Array.isArray(one.cut) &&
    one.cut.every((key) => typeof key === "string")
  );
};

// The rows of a decision item as the owner read them; null — not a decision
// of this product written by t-boards, or a broken one. The move date of a
// row is moveTo[id] (the queue server caps planEnd by it), not due[].eta.
export function readItemDue(
  item: { id: string; data: Record<string, unknown> } | null,
  product: string,
): DueRow[] | null {
  if (!item || !item.id.startsWith(dueItemPrefix(product))) return null;
  const { data } = item;
  if (data.kind !== "decision" || data.source !== DUE_SOURCE) return null;
  const due = Array.isArray(data.due) ? data.due.filter(isDueRow) : [];
  const moveTo =
    data.moveTo && typeof data.moveTo === "object"
      ? (data.moveTo as Record<string, unknown>)
      : {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return due.flatMap((row) => {
    const to = moveTo[row.id];
    return rows.includes(row.id) && typeof to === "string" && DATE.test(to)
      ? [{ ...row, eta: to }]
      : [];
  });
}

export function readState(data: Record<string, unknown> | undefined) {
  if (!data || data.kind !== "due" || typeof data.item !== "string") {
    return null;
  }
  if (!Array.isArray(data.rows)) return null;
  return data as DueState;
}

// The board's law (eval/tools/queue_focus.py focus): bugs before tasks, then
// by priority. The tail is the other end; a card in work is never cut.
const RANK: Record<string, number> = {
  urgent: 0,
  critical: 0,
  p0: 0,
  high: 1,
  p1: 1,
  medium: 2,
  p2: 2,
  low: 3,
  p3: 3,
};
const rankOf = (card: OpenCard) => RANK[card.level.toLowerCase()] ?? 4;

export function cutList(open: OpenCard[], lag: number, perDay: number) {
  const tail = open
    .filter((card) => !card.active)
    .sort(
      (a, b) =>
        Number(a.bug) - Number(b.bug) ||
        rankOf(b) - rankOf(a) ||
        b.key.localeCompare(a.key),
    );
  return tail.slice(0, Math.ceil(lag * perDay)).map((card) => card.key);
}

// The at-risk rows as the state keeps them: late and with work left.
export function dueRows(rows: RowForecast[], perDay: number): DueRow[] {
  const late = rows
    .filter((row) => row.lag > 0 && row.open.length > 0)
    .slice(0, STATE_ROWS)
    .map((row) => ({
      id: row.id,
      planEnd: row.planEnd,
      eta: row.eta,
      lag: row.lag,
      cut: cutList(row.open, row.lag, perDay).slice(0, CUT_MAX),
    }));
  while (late.length > 1 && JSON.stringify(late).length > STATE_BYTES) {
    late.pop();
  }
  return late;
}

// A new decision only when the late rows changed or a lag grew by 2 days:
// silence keeps the last one, and «оставить красными» is not asked again.
export function needsDecision(prev: DueState | null, late: DueRow[]) {
  if (late.length === 0) return false;
  if (!prev) return true;
  const before = new Map(prev.rows.map((row) => [row.id, row]));
  if (before.size !== late.length) return true;
  return late.some((row) => {
    const old = before.get(row.id);
    return !old || row.lag - old.lag >= LAG_STEP_DAYS;
  });
}

const day = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

export function dueItemData(input: {
  product: string;
  closed: number;
  perDay: number;
  late: DueRow[];
  titles: ReadonlyMap<string, string>;
  today: string;
}): Record<string, unknown> {
  const { late } = input;
  const lines = late.map((row) => {
    const cut =
      row.cut.length > 0 ? row.cut.join(", ") : "нечего — всё в работе";
    return `- ${input.titles.get(row.id) ?? row.id} — срок ${day(row.planEnd)}, прогноз ${day(row.eta)}, опаздывает на ${row.lag} дн.; держать срок — в бэклог: ${cut}`;
  });
  return {
    kind: "decision",
    title: `Сроки ${input.product}: ${late.length} строк не успевают по текущему темпу`,
    body: [
      `Темп: ${input.perDay.toFixed(1)} карточки в день — закрыто ${input.closed} за ${PACE_DAYS} дней. Строки идут по порядку фокуса, каждая после предыдущих.`,
      lines.join("\n"),
      "«Держать срок» — хвосты строк уходят в строку бэклога того же направления. «Перенести» — срок строки станет датой прогноза. «Оставить красными» — ничего не меняется. Молчание — ничего не меняется; новый вопрос — только если строки или отставание изменятся. Статус этого пункта ведёт только t-boards.",
    ].join("\n\n"),
    rows: late.map((row) => row.id),
    // «Перенести»: the date of each row the body names; the queue server lets
    // planEnd move up to it only (TB-112 part 1).
    moveTo: Object.fromEntries(late.map((row) => [row.id, row.eta])),
    // «Держать срок»: the cut cards the body names; the answer moves these.
    due: late,
    options: [
      {
        id: "keep",
        label: "Держать срок — хвосты строк в бэклог",
        hint: "рекомендую",
      },
      { id: "move", label: "Перенести сроки на прогноз" },
      { id: "red", label: "Оставить красными" },
    ],
    added: input.today,
    source: DUE_SOURCE,
  };
}
