// Plan rows of the owner queue («Ход работ», work/<id>) as the board sees
// them (TB-106). A row: {title, track, status, who, planStart, planEnd,
// start, end, note, cards[{key, ws, t, k, s, st, c}]}; a doc with a kind
// (track, stats, boards, focus) is not a row.

// A row card as the board sees it now.
export type BoardCard = {
  // The column slug, or the virtual «archived».
  status: string;
  final: boolean;
  // When the card entered a final column; null outside one.
  closedAt: Date | null;
};

// A card of a mapped workspace that moved lately (F8 candidates).
export type RecentCard = BoardCard & {
  ws: string;
  key: string;
  product: string;
  title: string;
  bug: boolean;
  // A bug's severity or a task's P0–P3, as cards[].s.
  level: string;
};

export type PlanRow = {
  id: string;
  version: number;
  data: Record<string, unknown>;
};

export type CardRef = { ws: string; key: string };

// in-progress and in-review make a row «doing» (F4).
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "in-progress",
  "in-review",
]);

// F9. cards[].c already holds the legacy card code (44 cards, 13.11), so the
// mark has a field of its own.
export const MARK_FIELD = "mark";
export const ABANDONED_MARK = "без аренды";

// F8: a closed card stays in the off-plan row this long.
export const OFF_PLAN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const offPlanSince = (now: Date) =>
  new Date(now.getTime() - OFF_PLAN_DAYS * DAY_MS);

const KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,7}$/;
const WS = /^[a-z0-9][a-z0-9-]{0,59}$/;

// The board card of a row entry; null for a legacy entry (a Notion id, a bare
// string) that the board cannot resolve.
export function cardRef(entry: unknown): CardRef | null {
  if (!entry || typeof entry !== "object") return null;
  const { ws, key } = entry as Record<string, unknown>;
  if (typeof ws !== "string" || typeof key !== "string") return null;
  return WS.test(ws) && KEY.test(key) ? { ws, key } : null;
}

// One card, whatever the case of its project key.
export const cardUid = (ws: string, key: string) =>
  `${ws}/${key.toUpperCase()}`;

export const offPlanRowId = (product: string) => `w-${product}-unplanned`;
export const isOffPlanRow = (id: string) => /^w-[a-z0-9-]+-unplanned$/.test(id);

// The default product owns the rows without another product's prefix, as
// eval/tools/queue_focus.py plan_rows reads them.
export const DEFAULT_PLAN_PRODUCT = "hr-helper";

// The plan product of a row w-<product>-…; the longest prefix wins. null — not
// a plan row of these products.
export function rowProduct(id: string, products: string[]): string | null {
  if (!id.startsWith("w-")) return null;
  const owner = products
    .filter((product) => product !== DEFAULT_PLAN_PRODUCT)
    .filter((product) => id.startsWith(`w-${product}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (owner) return owner;
  return products.includes(DEFAULT_PLAN_PRODUCT) ? DEFAULT_PLAN_PRODUCT : null;
}

// The row dates are the owner's local dates, as the rest of the module shows
// times (Europe/Moscow).
const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const localDate = (date: Date) => LOCAL_DATE.format(date);
