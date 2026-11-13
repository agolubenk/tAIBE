import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  publishTaskMutation,
  recordTaskMutation,
} from "../../task/controllers/task-mutation-effects";
import { withLockedTask } from "../../task/controllers/with-locked-task";
import { assertValidTaskStatus } from "../../task/validate-task-fields";
import { assertAssignableUser } from "../../utils/assert-assignable-user";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import {
  decideRollback,
  type HistoryChanges,
  withAutofill,
} from "./decide-rollback";
import {
  currentTaskFields,
  setHistoryActor,
  taskFields,
} from "./history-fields";

const FIXED = {
  projectId: "the card moved to another project; move it back first",
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function projectColumn(
  tx: Tx,
  projectId: string,
  restore: { status?: string; columnId?: string | null },
) {
  const [column] = await tx
    .select({ id: columnTable.id })
    .from(columnTable)
    .where(
      and(
        eq(columnTable.projectId, projectId),
        restore.status !== undefined
          ? eq(columnTable.slug, restore.status)
          : eq(columnTable.id, restore.columnId ?? ""),
      ),
    )
    .limit(1);
  return column;
}

const toDate = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

// Undoes one task edit under the row lock, with kaneo's own checks and
// effects: the status must still exist, the assignee must still be
// assignable, activity and live updates fire as for any edit.
export async function restoreTask(input: {
  taskId: string;
  workspaceId: string;
  changes: HistoryChanges;
  // The autofill the edit caused, undone with it (TB-69).
  autofill?: HistoryChanges;
  actor: ForestActor;
}) {
  const { taskId, actor } = input;
  const { before, after } = await withLockedTask(taskId, async (tx, task) => {
    const current = await currentTaskFields(tx, taskId);
    const decision = decideRollback(
      withAutofill(input.changes, input.autofill, current),
      current,
      FIXED,
    );
    if (!decision.ok)
      throw new ForestError("history_conflict", decision.reason);
    const parsed = taskFields.safeParse(decision.restore);
    if (!parsed.success) {
      throw new ForestError(
        "history_conflict",
        "the recorded values no longer fit the task",
      );
    }
    const restore = parsed.data;

    // The column follows the status, as in kaneo's update; a column restored
    // alone counts only while it is still in the project.
    if (restore.status !== undefined) {
      await assertValidTaskStatus(restore.status, task.projectId, tx);
    }
    const column =
      restore.status !== undefined || restore.columnId
        ? await projectColumn(tx, task.projectId, restore)
        : undefined;
    const columnId =
      restore.status !== undefined || restore.columnId
        ? (column?.id ?? null)
        : restore.columnId;
    if (restore.assigneeId) {
      await assertAssignableUser(
        restore.assigneeId,
        input.workspaceId,
        task.projectId,
        tx,
      );
    }

    await setHistoryActor(tx, actor.id);
    const [updated] = await tx
      .update(taskTable)
      .set({
        title: restore.title,
        description: restore.description,
        status: restore.status,
        columnId,
        priority: restore.priority,
        userId: restore.assigneeId,
        startDate: toDate(restore.startDate),
        dueDate: toDate(restore.dueDate),
      })
      .where(eq(taskTable.id, taskId))
      .returning();
    if (!updated) throw new HTTPException(404, { message: "Task not found" });
    await recordTaskMutation(
      tx,
      task,
      { title: restore.title, dueDate: toDate(restore.dueDate) },
      actor.userId,
    );
    return updated;
  });

  await publishTaskMutation(before, after, actor.userId);
  await publishEvent("task.updated", {
    taskId: after.id,
    projectId: after.projectId,
    title: after.title,
    status: after.status,
    userId: actor.userId,
  });
  return after;
}
