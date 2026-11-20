import { eq } from "drizzle-orm";
import type { ownerApprovalTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import { applyTaskStatusInTx } from "../../task/controllers/apply-task-status";
import { publishTaskMutation } from "../../task/controllers/task-mutation-effects";
import type { ForestActor } from "../actor";
import { isClosingStatus } from "../agent-guard/closing-status";
import { fellInTx, publishFelling } from "../fell/fell-trees";
import type { Tx } from "../tx";
import type { ActionOutcome, AppliedStep } from "./action-outcome";
import { ApprovalFailure } from "./approval-failure";
import { assertApprovedStatus } from "./approved-status";
import {
  type ApprovalAction,
  approvalParamsHash,
  isGrantApprovalAction,
} from "./approval-params";
import { applyBatchClose } from "./batch-close-apply";
import { isBatchClose } from "./batch-close-params";
import {
  attachLabelGrant,
  createLabelGrant,
  setAssigneeGrant,
} from "./grant-actions";
import { grantItems } from "./grant-items";
import { lockApprovalTask } from "./locked-target";
import { statusPath } from "./status-path";

export type ApprovalRow = typeof ownerApprovalTable.$inferSelect;

const NOTHING: ActionOutcome = { steps: [], publish: async () => {} };

// The stored hash binds what the owner saw; a row whose params no longer
// produce it is refused rather than applied.
function assertTaskValueHash(approval: ApprovalRow, value: string) {
  const hash = approvalParamsHash(
    approval.action as ApprovalAction,
    approval.targetId,
    [value],
  );
  if (hash !== approval.paramsHash) {
    throw new ApprovalFailure("params_mismatch");
  }
}

async function applyStatus(
  tx: Tx,
  approval: ApprovalRow,
  actor: ForestActor,
): Promise<ActionOutcome> {
  const target = approval.params?.status;
  if (!target) throw new ApprovalFailure("params_missing");
  assertTaskValueHash(approval, target);
  const task = await lockApprovalTask(
    tx,
    approval.workspaceId,
    approval.targetId,
  );
  if (
    approval.action === "reopen_task" &&
    task.status !== target &&
    !(await isClosingStatus(task.projectId, task.status, tx))
  ) {
    throw new ApprovalFailure("card_not_closed");
  }
  const path = statusPath(task.status, target);
  if (path.kind === "already") return NOTHING;
  if (path.kind === "unreachable") throw new ApprovalFailure(path.reason);
  await assertApprovedStatus(
    tx,
    task.projectId,
    target,
    approval.action === "close_task",
  );

  const changes: { before: typeof task; after: typeof task }[] = [];
  let current = task;
  for (const status of path.steps) {
    const after = await applyTaskStatusInTx(tx, current, status);
    changes.push({ before: current, after });
    current = after;
  }
  const steps: AppliedStep[] = changes.map(({ before, after }) => ({
    targetType: "task",
    targetId: task.id,
    field: "status",
    from: before.status,
    to: after.status,
  }));
  return {
    steps,
    publish: async () => {
      for (const { before, after } of changes) {
        await publishTaskMutation(before, after, actor.userId, {
          fields: ["status"],
        });
      }
    },
  };
}

async function applyPriority(
  tx: Tx,
  approval: ApprovalRow,
  actor: ForestActor,
): Promise<ActionOutcome> {
  const priority = approval.params?.priority;
  if (!priority) throw new ApprovalFailure("params_missing");
  assertTaskValueHash(approval, priority);
  const before = await lockApprovalTask(
    tx,
    approval.workspaceId,
    approval.targetId,
  );
  if (before.priority === priority) return NOTHING;
  const [after] = await tx
    .update(taskTable)
    .set({ priority })
    .where(eq(taskTable.id, before.id))
    .returning();
  if (!after) throw new Error("priority update returned no row");
  return {
    steps: [
      {
        targetType: "task",
        targetId: before.id,
        field: "priority",
        from: before.priority,
        to: priority,
      },
    ],
    publish: () =>
      publishTaskMutation(before, after, actor.userId, {
        fields: ["priority"],
      }),
  };
}

async function applyFelling(
  tx: Tx,
  approval: ApprovalRow,
  actor: ForestActor,
): Promise<ActionOutcome> {
  const action = approval.action === "fell_tree" ? "fell_tree" : "fell_sector";
  const outcome = await fellInTx(
    tx,
    {
      workspaceId: approval.workspaceId,
      actor,
      reason: approval.reason ?? "",
      appliedApproval: { id: approval.id, paramsHash: approval.paramsHash },
      ...(action === "fell_tree"
        ? { kind: "tree" as const, rootId: approval.targetId }
        : { kind: "sector" as const, sectorId: approval.targetId }),
    },
    action,
    approval.targetId,
  );
  return {
    steps: [
      {
        targetType: approval.targetType,
        targetId: approval.targetId,
        field: "felled",
        from: null,
        to: outcome.result.fellingId,
      },
    ],
    publish: () => publishFelling(outcome, actor.userId),
  };
}

// Applies an approved request inside the caller's transaction (TB-102): the
// whole path (R-8) or nothing. A domain refusal throws ApprovalFailure or a
// 4xx HTTPException; the caller turns it into «failed».
export async function runApprovalAction(
  tx: Tx,
  approval: ApprovalRow,
  actor: ForestActor,
): Promise<ActionOutcome> {
  const params = approval.params ?? {};
  const action = approval.action as ApprovalAction;
  if (
    isGrantApprovalAction(action) &&
    approvalParamsHash(
      action,
      approval.targetId,
      grantItems(action, params),
    ) !== approval.paramsHash
  ) {
    throw new ApprovalFailure("params_mismatch");
  }
  switch (action) {
    case "close_task":
      // TB-108: a list of cards, each to its project's final column.
      return isBatchClose(action, approval.params)
        ? applyBatchClose(tx, approval, actor)
        : applyStatus(tx, approval, actor);
    case "reopen_task":
      return applyStatus(tx, approval, actor);
    case "set_priority":
      return applyPriority(tx, approval, actor);
    case "fell_tree":
    case "fell_sector":
      return applyFelling(tx, approval, actor);
    case "create_label":
      return createLabelGrant(tx, approval.workspaceId, params);
    case "attach_label":
      return attachLabelGrant(
        tx,
        approval.workspaceId,
        approval.targetId,
        params,
      );
    case "set_assignee":
      return setAssigneeGrant(
        tx,
        approval.workspaceId,
        approval.targetId,
        params,
        actor.userId,
      );
    default:
      throw new ApprovalFailure("unknown_action");
  }
}
