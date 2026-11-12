import { and, eq, gte } from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import type { ForestActor } from "../actor";
import { setHistoryActor } from "../history/history-fields";
import { writeJournal } from "../journal";
import type { Tx } from "../tx";
import { failureReason } from "./approval-failure";
import { type ApprovalRow, runApprovalAction } from "./run-approval-action";

// Who answered and when (R-3). For the queue the time is the server time of
// the queue event that set the answer, not the browser's «at».
export type OwnerAnswer = {
  via: "ui" | "queue";
  answeredAt: Date;
  answeredBy: string;
  note?: string;
  queueItemId?: string;
  queueItemVersion?: number;
};

export type DecideOutcome =
  | { kind: "consumed"; approval: ApprovalRow; changed: number }
  | { kind: "rejected"; approval: ApprovalRow }
  | { kind: "failed"; approval: ApprovalRow; reason: string }
  // Not pending any more, or answered after its term (R-5, R-7, R-13).
  | { kind: "not_pending" };

// Card history names the owner by the channel (R-6): «owner-queue» for an
// answer from the owner queue, the browser session for t-boards itself.
export const OWNER_QUEUE_HISTORY_ACTOR = "owner-queue";

function answerDetail(approvalId: string, answer: OwnerAnswer) {
  const item = answer.queueItemId
    ? ` item=${answer.queueItemId}@v${answer.queueItemVersion ?? "?"}`
    : "";
  const note = answer.note ? ` note=${JSON.stringify(answer.note)}` : "";
  return `approval ${approvalId} via=${answer.via} by=${answer.answeredBy} at=${answer.answeredAt.toISOString()}${item}${note}`;
}

// R-5: the move out of «pending» is a conditional update; a second pass over
// the same answer finds nothing to move and changes nothing. R-7: the term
// covers the answer time, not the time this pass reads it.
function pendingWhere(approvalId: string, workspaceId: string, at: Date) {
  return and(
    eq(ownerApprovalTable.id, approvalId),
    eq(ownerApprovalTable.workspaceId, workspaceId),
    eq(ownerApprovalTable.status, "pending"),
    gte(ownerApprovalTable.expiresAt, at),
  );
}

async function reject(
  approvalId: string,
  workspaceId: string,
  actor: ForestActor,
  answer: OwnerAnswer,
): Promise<DecideOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerApprovalTable)
      .set({
        status: "rejected",
        decidedByUserId: actor.userId,
        decidedVia: answer.via,
        decidedAt: answer.answeredAt,
      })
      .where(pendingWhere(approvalId, workspaceId, answer.answeredAt))
      .returning();
    if (!row) return { kind: "not_pending" } as const;
    await writeJournal(
      {
        workspaceId,
        actor,
        action: "approval.rejected",
        targetType: row.targetType,
        targetId: row.targetId,
        outcome: "allowed",
        detail: answerDetail(approvalId, answer),
      },
      tx,
    );
    return { kind: "rejected", approval: row } as const;
  });
}

async function journalApplied(
  tx: Tx,
  row: ApprovalRow,
  actor: ForestActor,
  steps: Awaited<ReturnType<typeof runApprovalAction>>["steps"],
) {
  for (const step of steps) {
    await writeJournal(
      {
        workspaceId: row.workspaceId,
        actor,
        action: "approval.applied",
        targetType: step.targetType,
        targetId: step.targetId,
        outcome: "allowed",
        detail: `approval ${row.id} ${row.action} ${step.field}: ${step.from ?? "∅"} → ${step.to ?? "∅"}`,
      },
      tx,
    );
  }
}

async function markFailed(
  approvalId: string,
  workspaceId: string,
  actor: ForestActor,
  answer: OwnerAnswer,
  reason: string,
): Promise<DecideOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerApprovalTable)
      .set({
        status: "failed",
        failReason: reason,
        decidedByUserId: actor.userId,
        decidedVia: answer.via,
        decidedAt: answer.answeredAt,
      })
      .where(pendingWhere(approvalId, workspaceId, answer.answeredAt))
      .returning();
    if (!row) return { kind: "not_pending" } as const;
    await writeJournal(
      {
        workspaceId,
        actor,
        action: "approval.failed",
        targetType: row.targetType,
        targetId: row.targetId,
        outcome: "denied",
        detail: `${answerDetail(approvalId, answer)} reason=${reason}`,
      },
      tx,
    );
    return { kind: "failed", approval: row, reason } as const;
  });
}

// One function for «да»/«нет» from the t-boards UI (R-12) and from the owner
// queue: decide and apply in one transaction, no separate «approved» state.
// A domain refusal ends as «failed» with its reason; any other error rolls
// back and leaves the request «pending» for the next pass.
export async function decideAndApply({
  approvalId,
  workspaceId,
  decision,
  actor,
  answer,
}: {
  approvalId: string;
  workspaceId: string;
  decision: "approved" | "rejected";
  actor: ForestActor;
  answer: OwnerAnswer;
}): Promise<DecideOutcome> {
  if (decision === "rejected") {
    return reject(approvalId, workspaceId, actor, answer);
  }
  let applied: Awaited<ReturnType<typeof runApprovalAction>> | null = null;
  let outcome: DecideOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const decidedAt = new Date();
      const [row] = await tx
        .update(ownerApprovalTable)
        .set({
          status: "consumed",
          decidedByUserId: actor.userId,
          decidedVia: answer.via,
          decidedAt: answer.answeredAt,
          consumedAt: decidedAt,
        })
        .where(pendingWhere(approvalId, workspaceId, answer.answeredAt))
        .returning();
      if (!row) return { kind: "not_pending" } as const;
      await setHistoryActor(
        tx,
        answer.via === "queue" ? OWNER_QUEUE_HISTORY_ACTOR : actor.id,
      );
      await writeJournal(
        {
          workspaceId,
          actor,
          action: "approval.approved",
          targetType: row.targetType,
          targetId: row.targetId,
          outcome: "allowed",
          detail: answerDetail(approvalId, answer),
        },
        tx,
      );
      applied = await runApprovalAction(tx, row, actor);
      await journalApplied(tx, row, actor, applied.steps);
      return {
        kind: "consumed",
        approval: row,
        changed: applied.steps.length,
      } as const;
    });
  } catch (error) {
    const reason = failureReason(error);
    if (reason === null) throw error;
    return markFailed(approvalId, workspaceId, actor, answer, reason);
  }
  const done = applied as Awaited<ReturnType<typeof runApprovalAction>> | null;
  if (done) {
    await done.publish().catch((error: unknown) => {
      console.error("Failed to publish an applied approval:", error);
    });
  }
  return outcome;
}
