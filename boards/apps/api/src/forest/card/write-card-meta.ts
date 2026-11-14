import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import type { CardMetaPatch } from "./card-patch";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (
    (error as { code?: string })?.code === UNIQUE_VIOLATION ||
    cause?.code === UNIQUE_VIOLATION
  );
}

// Upsert: the first write creates the row with the defaults for the rest.
// With expectedRevision (TB-142) the write is conditional in one statement and
// answers undefined if the fields moved: null — only a card without a row,
// a revision — only a row still at it (updated_at to the millisecond).
export async function writeCardMeta(input: {
  taskId: string;
  workspaceId: string;
  patch: CardMetaPatch;
  actorId: string;
  expectedRevision?: string | null;
}) {
  const { costUsd, ...rest } = input.patch;
  const values = {
    ...rest,
    ...(costUsd === undefined
      ? {}
      : { costUsd: costUsd === null ? null : costUsd.toFixed(4) }),
    updatedBy: input.actorId,
    updatedAt: new Date(),
  };
  // An update moves the revision strictly forward: two writes in one
  // millisecond or a clock step back never share one. The ISO string, not a
  // Date param: the driver would send local time, and ::timestamp drops zones.
  const set = {
    ...values,
    updatedAt: sql`greatest(${values.updatedAt.toISOString()}::timestamp, date_trunc('milliseconds', ${cardMetaTable.updatedAt}) + interval '1 millisecond')`,
  };
  const insert = db.insert(cardMetaTable).values({
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    ...values,
  });
  const { expectedRevision } = input;
  try {
    if (expectedRevision === undefined) {
      const [row] = await insert
        .onConflictDoUpdate({ target: cardMetaTable.taskId, set })
        .returning();
      return row;
    }
    if (expectedRevision === null) {
      // The target keeps a taken Backlog ID a 23505, not a silent miss.
      const [row] = await insert
        .onConflictDoNothing({ target: cardMetaTable.taskId })
        .returning();
      return row;
    }
    const [row] = await db
      .update(cardMetaTable)
      .set(set)
      .where(
        and(
          eq(cardMetaTable.taskId, input.taskId),
          sql`date_trunc('milliseconds', ${cardMetaTable.updatedAt}) = ${expectedRevision}::timestamp`,
        ),
      )
      .returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HTTPException(409, {
        message: "backlogId is already used by another card in this workspace",
      });
    }
    throw error;
  }
}
