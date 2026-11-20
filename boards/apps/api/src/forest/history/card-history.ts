import { and, desc, eq } from "drizzle-orm";
import { AUTOFILL_FIELDS } from "./decide-rollback";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { cardHistoryTable } from "../../database/forest-schema";

export const HISTORY_PAGE_MAX = 100;

export async function listCardHistory(taskId: string, take: number) {
  return db
    .select()
    .from(cardHistoryTable)
    .where(eq(cardHistoryTable.taskId, taskId))
    .orderBy(desc(cardHistoryTable.createdAt))
    .limit(Math.min(take, HISTORY_PAGE_MAX));
}

export async function loadHistoryEntry(taskId: string, historyId: string) {
  const [entry] = await db
    .select()
    .from(cardHistoryTable)
    .where(
      and(
        eq(cardHistoryTable.id, historyId),
        eq(cardHistoryTable.taskId, taskId),
      ),
    )
    .limit(1);
  if (!entry) {
    throw new HTTPException(404, { message: "History entry not found" });
  }
  return entry;
}

type HistoryRow = typeof cardHistoryTable.$inferSelect;

// The autofill an agent's move caused: the very next task row (revision + 1,
// so no other write came between), by the same agent, touching only the
// autofill fields. Kaneo's own routes write rows without an actor, so a
// person's edit never counts as an agent's autofill.
export async function loadAutofillOf(
  entry: HistoryRow,
): Promise<HistoryRow | null> {
  if (
    entry.kind !== "task" ||
    !entry.actorId ||
    entry.revision === null ||
    !("status" in entry.changes)
  ) {
    return null;
  }
  const [next] = await db
    .select()
    .from(cardHistoryTable)
    .where(
      and(
        eq(cardHistoryTable.taskId, entry.taskId),
        eq(cardHistoryTable.kind, "task"),
        eq(cardHistoryTable.revision, entry.revision + 1),
      ),
    )
    .limit(1);
  if (!next || next.actorId !== entry.actorId) return null;
  const fields = Object.keys(next.changes);
  return fields.length > 0 &&
    fields.every((field) => AUTOFILL_FIELDS.has(field))
    ? next
    : null;
}
