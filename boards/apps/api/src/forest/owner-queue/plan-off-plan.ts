import {
  type BoardCard,
  cardRef,
  cardUid,
  offPlanSince,
  type RecentCard,
} from "./plan-types";

// The page shows up to 150 cards of a row.
export const OFF_PLAN_MAX = 150;
const TITLE_MAX = 120;

function closedLongAgo(card: BoardCard | undefined, since: Date) {
  return Boolean(card?.final && card.closedAt && card.closedAt < since);
}

function entryOf(card: RecentCard): Record<string, unknown> {
  return {
    key: card.key,
    ws: card.ws,
    t: card.title.slice(0, TITLE_MAX),
    k: card.bug ? "bug" : "task",
    s: card.level,
    st: card.status,
  };
}

// F8: the product's off-plan row w-<slug>-unplanned. A card leaves when a plan
// row holds it or when it closed more than 14 days ago; a card that moved to
// in-progress, in-review or a final column in that time and that no plan row
// holds joins it once (one entry per card).
export function refreshOffPlan(input: {
  cards: unknown[];
  board: ReadonlyMap<string, BoardCard>;
  // Cards of every other row that is not archived: a card of a done row was
  // planned work too.
  planned: ReadonlySet<string>;
  recent: RecentCard[];
  now: Date;
}): unknown[] {
  const since = offPlanSince(input.now);
  const seen = new Set<string>();
  const kept = input.cards.filter((entry) => {
    const ref = cardRef(entry);
    if (!ref) return true;
    const uid = cardUid(ref.ws, ref.key);
    if (seen.has(uid)) return false;
    seen.add(uid);
    return (
      !input.planned.has(uid) && !closedLongAgo(input.board.get(uid), since)
    );
  });
  for (const card of input.recent) {
    if (kept.length >= OFF_PLAN_MAX) break;
    const uid = cardUid(card.ws, card.key);
    if (seen.has(uid) || input.planned.has(uid)) continue;
    if (card.final && !(card.closedAt && card.closedAt >= since)) continue;
    seen.add(uid);
    kept.push(entryOf(card));
  }
  return kept;
}
