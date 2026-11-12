import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
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
          ne(ownerApprovalTable.queueSyncedStatus, ownerApprovalTable.status),
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
export async function saveItemState(
  approvalId: string,
  itemId: string,
  state: { version?: number; synced?: string },
) {
  await db
    .update(ownerApprovalTable)
    .set({
      ...(state.version === undefined
        ? {}
        : { queueItemVersion: state.version }),
      ...(state.synced === undefined
        ? {}
        : { queueSyncedStatus: state.synced }),
    })
    .where(
      and(
        eq(ownerApprovalTable.id, approvalId),
        eq(ownerApprovalTable.queueItemId, itemId),
      ),
    );
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
