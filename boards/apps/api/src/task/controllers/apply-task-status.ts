import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { assertValidTaskStatus } from "../validate-task-fields";

type TaskTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Task = typeof taskTable.$inferSelect;

// One status write inside the caller's transaction, with the card locked by
// the caller. The status route and the owner's «да» (TB-102 R-8) share it.
export async function applyTaskStatusInTx(
  tx: TaskTransaction,
  before: Task,
  status: string,
): Promise<Task> {
  await assertValidTaskStatus(status, before.projectId, tx);

  const column = await tx.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, before.projectId),
      eq(columnTable.slug, status),
    ),
  });

  // Brevna guards (spec R-007, D-011): the closed column is a timber
  // yard — a card enters it only from done, and never leaves it.
  if (status === "closed" && before.status !== "closed") {
    if (before.status !== "done") {
      throw new HTTPException(409, {
        message: "Брёвна принимают только из Done",
      });
    }
  }
  if (before.status === "closed" && status !== "closed") {
    throw new HTTPException(409, {
      message: "Карточка в Брёвнах — терминальный статус",
    });
  }

  const [updated] = await tx
    .update(taskTable)
    .set({ status, columnId: column?.id ?? null })
    .where(eq(taskTable.id, before.id))
    .returning();

  if (!updated) {
    throw new HTTPException(500, {
      message: "Failed to update task status",
    });
  }
  return updated;
}
