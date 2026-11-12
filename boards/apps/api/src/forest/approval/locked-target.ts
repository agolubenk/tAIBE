import { eq } from "drizzle-orm";
import { projectTable, taskTable } from "../../database/schema";
import { findFelledLog } from "../find-felled-log";
import type { Tx } from "../tx";
import { ApprovalFailure } from "./approval-failure";

export type LockedTask = typeof taskTable.$inferSelect;

// The card a «да» acts on, locked for the rest of the transaction. A card
// that is gone, felled or moved out of the workspace fails the request.
export async function lockApprovalTask(
  tx: Tx,
  workspaceId: string,
  taskId: string,
): Promise<LockedTask> {
  const [row] = await tx
    .select({ task: taskTable, workspaceId: projectTable.workspaceId })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId))
    .for("update", { of: taskTable });
  if (!row || row.workspaceId !== workspaceId) {
    throw new ApprovalFailure("target_gone");
  }
  // Felled cards stay readable in «Брёвна» but take no more writes.
  if (await findFelledLog(taskId, tx, workspaceId)) {
    throw new ApprovalFailure("target_felled");
  }
  return row.task;
}
