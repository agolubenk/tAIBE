import { ACTIVE_STATUSES, type BoardCard } from "./plan-types";

// F4: the row status that the board implies, as the fields to change ({} —
// keep). cards holds one entry per row card; undefined — not found on the
// board, which never counts as final. A blocked row and an owner's row keep
// their status. planEnd is never written: the lag is counted from it.
export function statusPatch(
  data: Record<string, unknown>,
  cards: (BoardCard | undefined)[],
  today: string,
): Record<string, unknown> {
  const status = data.status;
  if (status === "blocked" || data.who === "owner") return {};
  const found = cards.filter((card): card is BoardCard => card !== undefined);
  const allFinal =
    cards.length > 0 &&
    found.length === cards.length &&
    found.every((card) => card.final);
  if (allFinal) return status === "done" ? {} : { status: "done", end: today };
  // A done row with work left reopens without its end date.
  const reopen =
    status === "done" && data.end !== undefined ? { end: null } : {};
  if (found.some((card) => ACTIVE_STATUSES.has(card.status))) {
    return status === "doing" ? {} : { status: "doing", ...reopen };
  }
  if (status === "done" && found.some((card) => !card.final)) {
    return { status: "planned", ...reopen };
  }
  return {};
}
