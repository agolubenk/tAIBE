import { refreshOffPlan } from "./plan-off-plan";
import { statusPatch } from "./plan-status";
import {
  ABANDONED_MARK,
  type BoardCard,
  cardRef,
  cardUid,
  isOffPlanRow,
  MARK_FIELD,
  offPlanRowId,
  type PlanRow,
  type RecentCard,
} from "./plan-types";

// The hourly part of a run (F8, F9).
export type HourlyInput = {
  // Cards in in-progress without a live lease and without an update for 24 h.
  abandoned: ReadonlySet<string>;
  recent: RecentCard[];
  products: string[];
  now: Date;
};

export type RowWrite = {
  id: string;
  version: number;
  patch: Record<string, unknown>;
  // Writes that change a status go first when the run budget is short.
  rank: number;
};

const uidOf = (entry: unknown) => {
  const ref = cardRef(entry);
  return ref ? cardUid(ref.ws, ref.key) : null;
};

// F4 st and F9 mark of one entry; a card the board does not know stays as it is.
function followCard(
  entry: unknown,
  board: ReadonlyMap<string, BoardCard>,
  abandoned: ReadonlySet<string> | null,
): unknown {
  const uid = uidOf(entry);
  const card = uid ? board.get(uid) : undefined;
  if (!uid || !card) return entry;
  const next: Record<string, unknown> = {
    ...(entry as Record<string, unknown>),
    st: card.status,
  };
  if (abandoned?.has(uid)) next[MARK_FIELD] = ABANDONED_MARK;
  else if (abandoned && next[MARK_FIELD] === ABANDONED_MARK) {
    delete next[MARK_FIELD];
  }
  return next;
}

// Cards held by plan rows other than the off-plan rows.
function plannedCards(rows: PlanRow[]): Set<string> {
  const planned = new Set<string>();
  for (const row of rows) {
    if (isOffPlanRow(row.id) || !Array.isArray(row.data.cards)) continue;
    for (const entry of row.data.cards) {
      const uid = uidOf(entry);
      if (uid) planned.add(uid);
    }
  }
  return planned;
}

// Every row write of one run: the fields that changed, nothing else. rows are
// plan rows that are not archived.
export function planWrites(input: {
  rows: PlanRow[];
  board: ReadonlyMap<string, BoardCard>;
  today: string;
  hourly: HourlyInput | null;
}): { writes: RowWrite[]; missing: string[] } {
  const { rows, today, hourly } = input;
  const board = new Map(input.board);
  for (const card of hourly?.recent ?? []) {
    board.set(cardUid(card.ws, card.key), card);
  }
  const offPlanOf = new Map(
    (hourly?.products ?? []).map((product) => [offPlanRowId(product), product]),
  );
  const planned = hourly ? plannedCards(rows) : new Set<string>();
  const writes: RowWrite[] = [];
  for (const row of rows) {
    const cards: unknown[] = Array.isArray(row.data.cards)
      ? row.data.cards
      : [];
    const product = offPlanOf.get(row.id);
    let next = cards;
    if (hourly && product) {
      next = refreshOffPlan({
        cards,
        board,
        planned,
        recent: hourly.recent.filter((card) => card.product === product),
        now: hourly.now,
      });
    }
    next = next.map((entry) =>
      followCard(entry, board, hourly?.abandoned ?? null),
    );
    const patch: Record<string, unknown> = {};
    if (JSON.stringify(next) !== JSON.stringify(cards)) patch.cards = next;
    // The off-plan row is a standing bucket: its status is the owner's.
    if (!isOffPlanRow(row.id)) {
      const found = cards.map((entry) => {
        const uid = uidOf(entry);
        return uid ? board.get(uid) : undefined;
      });
      Object.assign(patch, statusPatch(row.data, found, today));
    }
    if (Object.keys(patch).length === 0) continue;
    const rank = "status" in patch ? 0 : product ? 1 : 2;
    writes.push({ id: row.id, version: row.version, patch, rank });
  }
  const ids = new Set(rows.map((row) => row.id));
  const missing = [...offPlanOf.keys()].filter((id) => !ids.has(id));
  return { writes: writes.sort((a, b) => a.rank - b.rank), missing };
}
