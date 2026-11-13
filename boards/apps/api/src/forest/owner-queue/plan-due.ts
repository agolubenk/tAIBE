import { type OpenCard, PACE_DAYS, type RowForecast } from "./plan-eta";

// F7.2: one owner decision per product about the rows that miss their term.
// Its state lives in work/due-<P> (kind «due»: not a plan row, the page skips
// a doc without a title); the queue server checks a later planEnd against the
// decision's rows and the «move» answer (TB-112 part 1).

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
const rankOf = (card: { level: string }) =>
  RANK[card.level.toLowerCase()] ?? 4;

// The board's law as a sort: the next card first.
export const byLaw = (
  a: { bug: boolean; level: string; key: string },
  b: { bug: boolean; level: string; key: string },
) =>
  Number(b.bug) - Number(a.bug) ||
  rankOf(a) - rankOf(b) ||
  a.key.localeCompare(b.key);

export function cutList(open: OpenCard[], lag: number, perDay: number) {
  const tail = open.filter((card) => !card.active).sort((a, b) => byLaw(b, a));
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
    source: "t-boards (TB-112)",
  };
}
