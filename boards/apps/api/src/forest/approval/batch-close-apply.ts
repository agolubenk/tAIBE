import { and, eq, gt, sql } from "drizzle-orm";
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
  const target = targets.get(card.projectId);
  if (!target || task.projectId !== card.projectId) {
    throw new ApprovalFailure("moved");
  }
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

// Bounds of one batch (Control lens on #160): a card another write holds
// longer than LOCK_WAIT is skipped as «locked», and no statement runs longer
// than STATEMENT_LIMIT. Both last until the end of the owner's transaction.
const LOCK_WAIT = "2s";
const STATEMENT_LIMIT = "10s";

// TB-114 п. 2: past LOCKED_LIMIT locked cards the whole batch waits for the
// next try. Without it 250 locked cards hold the owner's transaction
// 250 × LOCK_WAIT ≈ 8 min.
export const LOCKED_LIMIT = 5;

// Not a refusal: the whole request rolls back and stays pending; the queue
// counts the try (apply-deferral.ts), the t-boards UI answers 409.
export class BatchLocked extends Error {
  constructor() {
    super(`more than ${LOCKED_LIMIT} cards are locked by other writes`);
  }
}

function isLockTimeout(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "55P03"
  );
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

  await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_WAIT}'`));
  await tx.execute(
    sql.raw(`set local statement_timeout = '${STATEMENT_LIMIT}'`),
  );

  const changes: Change[] = [];
  const skipped: Skipped[] = [];
  let closed = 0;
  let locked = 0;
  // Cards are locked in id order: two writes over the same cards wait for
  // each other instead of a deadlock.
  const inLockOrder = [...batch.cards].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const card of inLockOrder) {
    try {
      const done = await tx.transaction((savepoint) =>
        closeOne(savepoint, approval.workspaceId, card, batch.targets),
      );
      changes.push(...done);
      if (done.length > 0) closed += 1;
    } catch (error) {
      const reason = isLockTimeout(error) ? "locked" : failureReason(error);
      if (reason === null) throw error;
      if (reason === "locked" && ++locked > LOCKED_LIMIT) {
        throw new BatchLocked();
      }
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
      detail: batchReport(
        closed,
        batch.cards.length,
        skipped.sort((a, b) =>
          a.key.localeCompare(b.key, "en", { numeric: true }),
        ),
      ),
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
