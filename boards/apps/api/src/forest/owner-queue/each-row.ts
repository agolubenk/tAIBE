import { QueueConflict, QueueRejected } from "./queue-client";

// A request whose document the queue refused (400/422) waits this long before
// the next try: the same document would be refused again (TB-110).
export const REJECT_PAUSE_MS = 10 * 60 * 1000;

// request id → time its pause ends (per process, like the sync back-off).
const rejectedUntil = new Map<string, number>();

export type RejectJournal = (
  workspaceId: string,
  action: string,
  targetId: string,
  detail: string,
) => Promise<unknown>;

// One step per request of a pass.
// - A version race (409) skips the item until the next pass.
// - A refused document (400/422) concerns only this request: it is journaled
//   once, paused for REJECT_PAUSE_MS, and the pass goes on (TB-110: one item
//   with a bad field stopped every request of both workspaces).
// - Any other failure (queue down, 401/403, 429, 5xx, database) ends the pass
//   and the caller backs off.
export async function eachRow<Row extends { id: string; workspaceId: string }>(
  rows: Row[],
  step: (row: Row) => Promise<unknown>,
  journal: RejectJournal,
  now: () => number = Date.now,
) {
  for (const row of rows) {
    const until = rejectedUntil.get(row.id);
    if (until !== undefined) {
      if (until > now()) continue;
      rejectedUntil.delete(row.id);
    }
    try {
      await step(row);
    } catch (error) {
      if (error instanceof QueueConflict) continue;
      if (!(error instanceof QueueRejected)) throw error;
      rejectedUntil.set(row.id, now() + REJECT_PAUSE_MS);
      await journal(
        row.workspaceId,
        "queue.item_rejected",
        row.id,
        error.message.slice(0, 500),
      );
    }
  }
}

// Tests only: forget the pauses between cases.
export function resetRejectedForTest() {
  rejectedUntil.clear();
}
