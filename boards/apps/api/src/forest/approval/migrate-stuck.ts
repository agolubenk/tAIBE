import { and, asc, eq, gt, isNull, like, notLike, or } from "drizzle-orm";
import db from "../../database";
import {
  agentJournalTable,
  cardHistoryTable,
  ownerApprovalTable,
} from "../../database/forest-schema";
import { columnTable, taskTable } from "../../database/schema";
import { setHistoryActor } from "../history/history-fields";
import { writeJournal } from "../journal";
import { ownerQueueActor } from "../owner-queue/queue-actor";
import { failureReason } from "./approval-failure";
import { type ApprovalRow, runApprovalAction } from "./run-approval-action";

// TB-102 R-11 (D-4): «approved» requests that were never spent. One
// transaction per request; a second run takes only what is left.
export type StuckPlan = {
  approvalId: string;
  workspaceId: string;
  action: string;
  targetId: string;
  outcome: "expired" | "consumed" | "apply";
  reason: string;
};

function stuckRows() {
  return db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.status, "approved"),
        isNull(ownerApprovalTable.consumedAt),
      ),
    )
    .orderBy(asc(ownerApprovalTable.createdAt))
    .limit(1000);
}

async function plan(row: ApprovalRow): Promise<StuckPlan> {
  const base = {
    approvalId: row.id,
    workspaceId: row.workspaceId,
    action: row.action,
    targetId: row.targetId,
  };
  if (row.action === "fell_tree" || row.action === "fell_sector") {
    return { ...base, outcome: "expired", reason: "fell_needs_new_yes" };
  }
  const [task] = await db
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, row.targetId));
  if (!task) return { ...base, outcome: "expired", reason: "target_gone" };
  const target = row.params?.status ?? row.params?.priority;
  const current = row.params?.status ? task.status : task.priority;
  if (target && current === target) {
    return { ...base, outcome: "consumed", reason: "already_applied" };
  }
  // Q-7: status and priority edits always leave a card_history row (trigger),
  // so «untouched since the «да»» is checked there.
  const since = row.decidedAt ?? row.createdAt;
  const [touched] = await db
    .select({ id: cardHistoryTable.id })
    .from(cardHistoryTable)
    .where(
      and(
        eq(cardHistoryTable.taskId, task.id),
        gt(cardHistoryTable.createdAt, since),
      ),
    )
    .limit(1);
  if (touched)
    return { ...base, outcome: "expired", reason: "changed_since_yes" };
  return { ...base, outcome: "apply", reason: "untouched" };
}

export async function planStuck(): Promise<StuckPlan[]> {
  const rows = await stuckRows();
  const plans: StuckPlan[] = [];
  for (const row of rows) plans.push(await plan(row));
  return plans;
}

const stuckWhere = (id: string) =>
  and(
    eq(ownerApprovalTable.id, id),
    eq(ownerApprovalTable.status, "approved"),
    isNull(ownerApprovalTable.consumedAt),
  );

async function close(
  item: StuckPlan,
  status: "expired" | "consumed",
  reason: string,
  runId: string,
) {
  const actor = await ownerQueueActor(item.workspaceId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ownerApprovalTable)
      .set({
        status,
        failReason: reason,
        ...(status === "consumed" ? { consumedAt: new Date() } : {}),
      })
      .where(stuckWhere(item.approvalId))
      .returning({ id: ownerApprovalTable.id });
    if (!row || !actor) return;
    await writeJournal(
      {
        workspaceId: item.workspaceId,
        actor: { ...actor, id: `owner-migration:${runId}` },
        action: status === "expired" ? "approval.expired" : "approval.consumed",
        targetType: "approval",
        targetId: item.approvalId,
        outcome: "allowed",
        detail: `migration run=${runId} reason=${reason}`,
      },
      tx,
    );
  });
}

async function apply(item: StuckPlan, runId: string) {
  const owner = await ownerQueueActor(item.workspaceId);
  if (!owner) return close(item, "expired", "workspace_has_no_owner", runId);
  const actor = { ...owner, id: `owner-migration:${runId}` };
  let publish: (() => Promise<void>) | null = null;
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(ownerApprovalTable)
        .set({ status: "consumed", consumedAt: new Date() })
        .where(stuckWhere(item.approvalId))
        .returning();
      if (!row) return;
      await setHistoryActor(tx, actor.id);
      const outcome = await runApprovalAction(tx, row, actor);
      for (const step of outcome.steps) {
        await writeJournal(
          {
            workspaceId: row.workspaceId,
            actor,
            action: "approval.applied",
            targetType: step.targetType,
            targetId: step.targetId,
            outcome: "allowed",
            detail: `approval ${row.id} ${row.action} ${step.field}: ${step.from ?? "∅"} → ${step.to ?? "∅"} run=${runId} migration`,
          },
          tx,
        );
      }
      publish = outcome.publish;
    });
  } catch (error) {
    const reason = failureReason(error);
    if (reason === null) throw error;
    return close(item, "expired", reason, runId);
  }
  const done = publish as (() => Promise<void>) | null;
  await done?.().catch((error: unknown) => {
    console.error("Failed to publish a migrated approval:", error);
  });
}

// One request failing for a non-domain reason (database, constraint) does
// not stop the run: it stays «approved», is named in the report, and the
// next run takes it again (correctness r2).
export async function runStuck(plans: StuckPlan[], runId: string) {
  const errors: string[] = [];
  for (const item of plans) {
    try {
      if (item.outcome === "apply") await apply(item, runId);
      else await close(item, item.outcome, item.reason, runId);
    } catch (error) {
      errors.push(
        `error ${item.approvalId} ${item.action} ${item.targetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

class RevertSkip extends Error {}

const APPLIED =
  /^approval (\S+) (\S+) (status|priority): (.+) → (.+) run=(\S+) migration$/;

// --revert <runId>: a step goes back only while the card still holds its
// «стало» and nobody touched the card after the migration.
export async function revertRun(runId: string) {
  const rows = await db
    .select()
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.action, "approval.applied"),
        like(agentJournalTable.detail, `% run=${runId} migration`),
      ),
    )
    .orderBy(asc(agentJournalTable.createdAt))
    .limit(1000);
  const report: string[] = [];
  for (const entry of rows.reverse()) {
    const match = APPLIED.exec(entry.detail ?? "");
    if (!match) {
      // Grants (labels, assignee) are not undone here: name them.
      report.push(`skip ${entry.targetId}: not revertible — ${entry.detail}`);
      continue;
    }
    const [, approvalId, , field, from, to] = match;
    const [task] = await db
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, entry.targetId));
    const value = field === "status" ? task?.status : task?.priority;
    const [later] = task
      ? await db
          .select({ id: cardHistoryTable.id })
          .from(cardHistoryTable)
          .where(
            and(
              eq(cardHistoryTable.taskId, task.id),
              gt(cardHistoryTable.createdAt, entry.createdAt),
              // Any server migration step (this run, its revert, another run)
              // is not a person's change; a null actor (kaneo routes) is.
              or(
                isNull(cardHistoryTable.actorId),
                notLike(cardHistoryTable.actorId, "owner-migration:%"),
              ),
            ),
          )
          .limit(1)
      : [];
    if (!task || value !== to || later) {
      report.push(
        `skip ${approvalId} ${entry.targetId} ${field}: now ${value ?? "gone"}${later ? ", changed after" : ""}`,
      );
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await setHistoryActor(tx, `owner-migration:${runId}:revert`);
        if (field === "status") {
          const [column] = await tx
            .select({ id: columnTable.id })
            .from(columnTable)
            .where(
              and(
                eq(columnTable.projectId, task.projectId),
                eq(columnTable.slug, from as string),
              ),
            );
          // The column is gone: a card without a column would drop off the
          // board, so this step is skipped (correctness r2).
          if (!column) throw new RevertSkip("column gone");
          await tx
            .update(taskTable)
            .set({ status: from as string, columnId: column.id })
            .where(eq(taskTable.id, task.id));
        } else {
          await tx
            .update(taskTable)
            .set({ priority: from as string })
            .where(eq(taskTable.id, task.id));
        }
        // The request no longer stands for a change on the card.
        await tx
          .update(ownerApprovalTable)
          .set({ status: "failed", failReason: `reverted:${runId}` })
          .where(eq(ownerApprovalTable.id, approvalId as string));
      });
    } catch (error) {
      if (!(error instanceof RevertSkip)) throw error;
      report.push(
        `skip ${approvalId} ${entry.targetId} ${field}: ${error.message}`,
      );
      continue;
    }
    report.push(
      `reverted ${approvalId} ${entry.targetId} ${field}: ${to} → ${from}`,
    );
  }
  return report;
}
