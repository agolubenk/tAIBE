import { and, eq, gt } from "drizzle-orm";
import { cardMetaTable, taskLeaseTable } from "../../database/forest-schema";
import { applyTaskStatusInTx } from "../../task/controllers/apply-task-status";
import { publishTaskMutation } from "../../task/controllers/task-mutation-effects";
import type { ForestActor } from "../actor";
import { writeJournal } from "../journal";
import type { Tx } from "../tx";
import type { ActionOutcome, AppliedStep } from "./action-outcome";
import { ApprovalFailure, failureReason } from "./approval-failure";
import { approvalParamsHash } from "./approval-params";
import {
  type BatchCard,
  batchCloseItems,
  parseBatchClose,
} from "./batch-close-params";
import { batchReport, type Skipped } from "./batch-close-report";
import { type LockedTask, lockApprovalTask } from "./locked-target";
import type { ApprovalRow } from "./run-approval-action";
import { statusPath } from "./status-path";

type Change = { before: LockedTask; after: LockedTask };

// One card, inside its own savepoint: a refusal rolls back only this card.
async function closeOne(
  tx: Tx,
  workspaceId: string,
  card: BatchCard,
  targets: Map<string, string>,
): Promise<Change[]> {
  const task = await lockApprovalTask(tx, workspaceId, card.id);
  const target = targets.get(task.projectId);
  if (!target) throw new ApprovalFailure("moved");
  // R-3: the card changed after the owner was asked — it is not closed.
  if (task.status !== card.from) {
    throw new ApprovalFailure(
      task.status === target ? "already_closed" : "changed",
    );
  }
  const [lease] = await tx
    .select({ holder: taskLeaseTable.holderName })
    .from(taskLeaseTable)
    .where(
      and(
        eq(taskLeaseTable.taskId, task.id),
        gt(taskLeaseTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (lease) throw new ApprovalFailure("leased");
  const [meta] = await tx
    .select({ halfBaked: cardMetaTable.halfBaked })
    .from(cardMetaTable)
    .where(eq(cardMetaTable.taskId, task.id))
    .limit(1);
  if (meta?.halfBaked) throw new ApprovalFailure("half_baked");
  const path = statusPath(task.status, target);
  if (path.kind === "already") return [];
  if (path.kind === "unreachable") throw new ApprovalFailure(path.reason);
  const changes: Change[] = [];
  let current = task;
  for (const status of path.steps) {
    const after = await applyTaskStatusInTx(tx, current, status);
    changes.push({ before: current, after });
    current = after;
  }
  return changes;
}

// TB-108 R-3: one «да» for a list of cards. Each card closes in its own
// savepoint; a card the server must not close is skipped with its reason
// (Пакет А, owner 13.11). An error that is not a refusal (database down)
// rolls the whole request back and leaves it pending.
export async function applyBatchClose(
  tx: Tx,
  approval: ApprovalRow,
  actor: ForestActor,
): Promise<ActionOutcome> {
  const batch = parseBatchClose(approval.params);
  if (!batch) throw new ApprovalFailure("params_missing");
  if (
    approvalParamsHash(
      "close_task",
      approval.targetId,
      batchCloseItems(batch),
    ) !== approval.paramsHash
  ) {
    throw new ApprovalFailure("params_mismatch");
  }

  const changes: Change[] = [];
  const skipped: Skipped[] = [];
  let closed = 0;
  for (const card of batch.cards) {
    try {
      const done = await tx.transaction((savepoint) =>
        closeOne(savepoint, approval.workspaceId, card, batch.targets),
      );
      changes.push(...done);
      if (done.length > 0) closed += 1;
    } catch (error) {
      const reason = failureReason(error);
      if (reason === null) throw error;
      skipped.push({ key: card.key, reason });
      await writeJournal(
        {
          workspaceId: approval.workspaceId,
          actor,
          action: "approval.skipped",
          targetType: "task",
          targetId: card.id,
          outcome: "denied",
          detail: `approval ${approval.id} close_task reason=${reason}`,
        },
        tx,
      );
    }
  }
  await writeJournal(
    {
      workspaceId: approval.workspaceId,
      actor,
      action: "approval.batch_report",
      targetType: "approval",
      targetId: approval.id,
      outcome: "allowed",
      detail: batchReport(closed, batch.cards.length, skipped),
    },
    tx,
  );

  const steps: AppliedStep[] = changes.map(({ before, after }) => ({
    targetType: "task",
    targetId: before.id,
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
