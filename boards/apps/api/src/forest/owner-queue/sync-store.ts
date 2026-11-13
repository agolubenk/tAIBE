import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notLike,
  or,
} from "drizzle-orm";
import db from "../../database";
import {
  agentJournalTable,
  ownerApprovalTable,
} from "../../database/forest-schema";
import {
  projectTable,
  taskTable,
  userTable,
  workspaceTable,
} from "../../database/schema";
import type { ItemCard } from "./item-text";

export type ApprovalRow = typeof ownerApprovalTable.$inferSelect;

// Not more than 100 requests per pass, oldest first (spec «Синхронизация»).
export const PASS_TAKE = 100;

export function pendingWithoutItem(workspaceIds: string[], now: Date) {
  return db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        inArray(ownerApprovalTable.workspaceId, workspaceIds),
        eq(ownerApprovalTable.status, "pending"),
        isNull(ownerApprovalTable.queueItemId),
        gt(ownerApprovalTable.expiresAt, now),
      ),
    )
    .orderBy(asc(ownerApprovalTable.createdAt))
    .limit(PASS_TAKE);
}

export function pendingWithItem(workspaceIds: string[]) {
  return db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        inArray(ownerApprovalTable.workspaceId, workspaceIds),
        eq(ownerApprovalTable.status, "pending"),
        isNotNull(ownerApprovalTable.queueItemId),
      ),
    )
    .orderBy(asc(ownerApprovalTable.createdAt))
    .limit(PASS_TAKE);
}

// Decided requests whose item does not show the outcome yet (step 4).
export function outcomeToShow(workspaceIds: string[]) {
  return db
    .select()
    .from(ownerApprovalTable)
    .where(
      and(
        inArray(ownerApprovalTable.workspaceId, workspaceIds),
        ne(ownerApprovalTable.status, "pending"),
        isNotNull(ownerApprovalTable.queueItemId),
        or(
          isNull(ownerApprovalTable.queueSyncedStatus),
          and(
            ne(ownerApprovalTable.queueSyncedStatus, ownerApprovalTable.status),
            notLike(ownerApprovalTable.queueSyncedStatus, "deleted:%"),
          ),
        ),
      ),
    )
    .orderBy(asc(ownerApprovalTable.createdAt))
    .limit(PASS_TAKE);
}

// Step 1: one instance claims the creation; a second t-boards instance finds
// the id taken and writes nothing to the queue (AC-23).
export async function claimItem(approvalId: string, itemId: string) {
  const [claimed] = await db
    .update(ownerApprovalTable)
    .set({ queueItemId: itemId })
    .where(
      and(
        eq(ownerApprovalTable.id, approvalId),
        isNull(ownerApprovalTable.queueItemId),
      ),
    )
    .returning({ id: ownerApprovalTable.id });
  return Boolean(claimed);
}

export async function releaseClaim(approvalId: string, itemId: string) {
  await db
    .update(ownerApprovalTable)
    .set({ queueItemId: null, queueItemVersion: null, queueSyncedStatus: null })
    .where(
      and(
        eq(ownerApprovalTable.id, approvalId),
        eq(ownerApprovalTable.queueItemId, itemId),
      ),
    );
}

// The item version after t-boards' own last write (R-4), and what it shows.
// The version only grows: a slow writer never puts back an older version
// than a parallel pass already saved (R-4).
export async function saveItemState(
  approvalId: string,
  itemId: string,
  state: { version?: number; synced?: string },
) {
  if (state.version !== undefined) {
    await db
      .update(ownerApprovalTable)
      .set({ queueItemVersion: state.version })
      .where(
        and(
          eq(ownerApprovalTable.id, approvalId),
          eq(ownerApprovalTable.queueItemId, itemId),
          or(
            isNull(ownerApprovalTable.queueItemVersion),
            lt(ownerApprovalTable.queueItemVersion, state.version),
          ),
        ),
      );
  }
  if (state.synced !== undefined) {
    await db
      .update(ownerApprovalTable)
      .set({ queueSyncedStatus: state.synced })
      .where(
        and(
          eq(ownerApprovalTable.id, approvalId),
          eq(ownerApprovalTable.queueItemId, itemId),
        ),
      );
  }
}

// The cards a label grant names, as keys (KEY-12) for the queue item.
// A batch close shows its first 10 cards (TB-108 R-5), a label grant all of
// its cards (at most 20).
export async function taskKeys(approval: ApprovalRow): Promise<string[]> {
  const shown = approval.action === "close_task" ? 10 : 20;
  const ids = (approval.params?.taskIds ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, shown);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: taskTable.id,
      slug: projectTable.slug,
      number: taskTable.number,
      title: taskTable.title,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(inArray(taskTable.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    return row ? `${row.slug}-${row.number ?? "?"} «${row.title}»` : id;
  });
}

export async function stillPending(approvalId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: ownerApprovalTable.status })
    .from(ownerApprovalTable)
    .where(eq(ownerApprovalTable.id, approvalId))
    .limit(1);
  return row?.status === "pending";
}

export async function workspaceName(workspaceId: string) {
  const [row] = await db
    .select({ name: workspaceTable.name })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  return row?.name ?? workspaceId;
}

// The card a task request is about, with the value it has now.
export async function itemCard(approval: ApprovalRow): Promise<ItemCard> {
  if (approval.targetType !== "task") return null;
  const [row] = await db
    .select({
      slug: projectTable.slug,
      number: taskTable.number,
      title: taskTable.title,
      status: taskTable.status,
      priority: taskTable.priority,
      assignee: userTable.name,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(eq(taskTable.id, approval.targetId))
    .limit(1);
  if (!row) return null;
  const current =
    approval.action === "set_priority"
      ? row.priority
      : approval.action === "set_assignee"
        ? (row.assignee ?? "—")
        : approval.action === "close_task" || approval.action === "reopen_task"
          ? row.status
          : null;
  return {
    key: `${row.slug}-${row.number ?? "?"}`,
    title: row.title,
    current,
  };
}

// TB-108: what a batch close did, written by applyBatchClose in the same
// transaction as the outcome.
export async function batchReportOf(
  approvalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ detail: agentJournalTable.detail })
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.targetType, "approval"),
        eq(agentJournalTable.targetId, approvalId),
        eq(agentJournalTable.action, "approval.batch_report"),
      ),
    )
    .limit(1);
  return row?.detail ?? null;
}
