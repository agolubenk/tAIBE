import { QueueConflict, QueueRejected } from "./queue-client";

// A request whose document the queue refused (400/422) waits this long before
// the next try: the same document would be refused again (TB-110).
export const REJECT_PAUSE_MS = 10 * 60 * 1000;

// request id → time its pause ends (per process, like the sync back-off).
const rejectedUntil = new Map<string, number>();
// requests already journaled as refused (per process): one journal row per
// request, not one per pause (Control lens on #151).
const journaled = new Set<string>();

export type RejectJournal = (
  workspaceId: string,
  action: string,
  targetId: string,
  detail: string,
) => Promise<unknown>;

function paused(id: string, now: number): boolean {
  const until = rejectedUntil.get(id);
  if (until === undefined) return false;
  if (until > now) return true;
  rejectedUntil.delete(id);
  return false;
}

// Drop the paused requests before the caller takes its share of a list:
// otherwise CREATE_PER_PASS refused requests (oldest first) would fill every
// pass and starve the new ones (Control lens on #151).
export function withoutPaused<Row extends { id: string }>(
  rows: Row[],
  now: () => number = Date.now,
): Row[] {
  const at = now();
  return rows.filter((row) => !paused(row.id, at));
}

// One step per request of a pass.
// - A version race (409) skips the item until the next pass.
// - A refused document (400/422) concerns only this request: it is journaled
//   once, then paused for REJECT_PAUSE_MS, and the pass goes on (TB-110: one
//   item with a bad field stopped every request of both workspaces). A failed
//   journal write ends the pass before the pause, so the next pass retries.
// - Any other failure (queue down, 401/403, 429, 5xx, database) ends the pass
//   and the caller backs off.
export async function eachRow<Row extends { id: string; workspaceId: string }>(
  rows: Row[],
  step: (row: Row) => Promise<unknown>,
  journal: RejectJournal,
  now: () => number = Date.now,
) {
  for (const row of withoutPaused(rows, now)) {
    try {
      await step(row);
    } catch (error) {
      if (error instanceof QueueConflict) continue;
      if (!(error instanceof QueueRejected)) throw error;
      if (!journaled.has(row.id)) {
        await journal(
          row.workspaceId,
          "queue.item_rejected",
          row.id,
          error.message.slice(0, 500),
        );
        journaled.add(row.id);
      }
      rejectedUntil.set(row.id, now() + REJECT_PAUSE_MS);
    }
  }
}

// Tests only: forget the pauses between cases.
export function resetRejectedForTest() {
  rejectedUntil.clear();
  journaled.clear();
}
