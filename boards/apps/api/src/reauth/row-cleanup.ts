import { and, inArray, like, lt } from "drizzle-orm";
import db from "../database";
import { verificationTable as table } from "../database/schema";

// TB-246: each row of reauth/store.ts (fresh mark, code, counters) has an
// identifier with this prefix and an expiry. Reads see only live rows
// (`liveRow`), so an expired row is dead data: one is left per sign-in.
export const REAUTH_ROW_PREFIX = "tb-reauth";

const BATCH = 500;

/**
 * Deletes the expired reauth rows in batches and returns how many. It does
 * not wait for a row that a reauth write holds (SKIP LOCKED), so it cannot
 * deadlock with one; that row goes at the next run. Live rows and other
 * `verification` rows (better-auth, `tb-email-`, `tb-device:`) stay.
 */
export async function deleteExpiredReauthRows(
  deadlineMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let deleted = 0;
  do {
    const count = await db.transaction(async (tx) => {
      const batch = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            like(table.identifier, `${REAUTH_ROW_PREFIX}%`),
            lt(table.expiresAt, new Date()),
          ),
        )
        .limit(BATCH)
        .for("update", { skipLocked: true });
      if (!batch.length) return 0;
      await tx.delete(table).where(
        inArray(
          table.id,
          batch.map((row) => row.id),
        ),
      );
      return batch.length;
    });
    deleted += count;
    if (count < BATCH) break;
  } while (Date.now() < deadline);
  return deleted;
}
