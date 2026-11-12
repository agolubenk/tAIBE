import { and, eq, isNull, sql } from "drizzle-orm";
import { labelTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { syncLabelToGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { syncLabelToGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { syncLabelToGitlab } from "../../plugins/gitlab/utils/sync-label-to-gitlab";
import { publishTaskMutation } from "../../task/controllers/task-mutation-effects";
import { assertAssignableUser } from "../../utils/assert-assignable-user";
import type { Tx } from "../tx";
import { ApprovalFailure } from "./approval-failure";
import type { ActionOutcome, AppliedStep } from "./action-outcome";
import { splitIds } from "./grant-items";
import { lockApprovalTask } from "./locked-target";

// TB-102 R-10: one-time rights the server carries out on the owner's «да».
// The agent never holds the right; the parameters are fixed by the request.

async function attachToTasks(
  tx: Tx,
  workspaceId: string,
  label: { name: string; color: string },
  taskIds: string[],
): Promise<ActionOutcome> {
  const steps: AppliedStep[] = [];
  const attached: { taskId: string; projectId: string }[] = [];
  for (const taskId of taskIds) {
    const task = await lockApprovalTask(tx, workspaceId, taskId);
    const [inserted] = await tx
      .insert(labelTable)
      .values({ ...label, taskId, workspaceId })
      .onConflictDoNothing({ target: [labelTable.taskId, labelTable.name] })
      .returning({ id: labelTable.id });
    if (!inserted) continue;
    attached.push({ taskId, projectId: task.projectId });
    steps.push({
      targetType: "task",
      targetId: taskId,
      field: "label",
      from: null,
      to: label.name,
    });
  }
  return {
    steps,
    publish: async () => {
      for (const { taskId, projectId } of attached) {
        await publishEvent("task.labels_updated", { projectId, taskId });
        for (const sync of [
          syncLabelToGitHub,
          syncLabelToGitea,
          syncLabelToGitlab,
        ]) {
          sync(taskId, label.name, label.color).catch((error: unknown) => {
            console.error("Failed to sync an approved label:", error);
          });
        }
      }
    },
  };
}

export async function createLabelGrant(
  tx: Tx,
  workspaceId: string,
  params: Record<string, string>,
): Promise<ActionOutcome> {
  const name = params.name;
  const color = params.color;
  if (!name || !color) throw new ApprovalFailure("params_missing");
  const existing = await tx.query.labelTable.findFirst({
    where: and(
      eq(labelTable.workspaceId, workspaceId),
      eq(labelTable.name, name),
      isNull(labelTable.taskId),
    ),
  });
  if (existing?.deletionStartedAt) throw new ApprovalFailure("label_deleting");
  await tx
    .insert(labelTable)
    .values({ name, color, taskId: null, workspaceId })
    .onConflictDoNothing({
      target: [labelTable.workspaceId, labelTable.name],
      where: sql`${labelTable.taskId} is null`,
    });
  return attachToTasks(
    tx,
    workspaceId,
    { name, color },
    splitIds(params.taskIds),
  );
}

export async function attachLabelGrant(
  tx: Tx,
  workspaceId: string,
  labelId: string,
  params: Record<string, string>,
): Promise<ActionOutcome> {
  const label = await tx.query.labelTable.findFirst({
    where: eq(labelTable.id, labelId),
  });
  if (!label || label.workspaceId !== workspaceId || label.taskId !== null) {
    throw new ApprovalFailure("label_gone");
  }
  if (label.deletionStartedAt) throw new ApprovalFailure("label_deleting");
  return attachToTasks(
    tx,
    workspaceId,
    { name: label.name, color: label.color },
    splitIds(params.taskIds),
  );
}

export async function setAssigneeGrant(
  tx: Tx,
  workspaceId: string,
  taskId: string,
  params: Record<string, string>,
  actorUserId: string,
): Promise<ActionOutcome> {
  const userId = params.userId;
  if (!userId) throw new ApprovalFailure("params_missing");
  const before = await lockApprovalTask(tx, workspaceId, taskId);
  if (before.userId === userId) return { steps: [], publish: async () => {} };
  await assertAssignableUser(userId, workspaceId, before.projectId, tx);
  const [after] = await tx
    .update(taskTable)
    .set({ userId })
    .where(eq(taskTable.id, taskId))
    .returning();
  if (!after) throw new Error("assignee update returned no row");
  return {
    steps: [
      {
        targetType: "task",
        targetId: taskId,
        field: "assignee",
        from: before.userId,
        to: userId,
      },
    ],
    publish: () =>
      publishTaskMutation(before, after, actorUserId, { fields: ["userId"] }),
  };
}
