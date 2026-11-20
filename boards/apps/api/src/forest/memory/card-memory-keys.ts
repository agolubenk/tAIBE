import { MAX_MEMORY_KEYS, memoryKeyForm } from "@kaneo/claude-mem-reader";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import db from "../../database";
import {
  cardMetaTable,
  ownerApprovalTable,
} from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";

// What a card's memory is searched by (TB-113, C-1/C-2): its id, its board key
// (TB-108), its Backlog ID and the owner-queue items of its «да» requests,
// newest first. Keys outside the forms the Mac proxy accepts are left out — a
// project key in Cyrillic, a Backlog ID like «B-6» — and the branch is not a
// key in v1: «main» names thousands of other observations.
export function orderMemoryKeys(candidates: (string | null | undefined)[]) {
  const keys: string[] = [];
  for (const key of candidates) {
    if (!key || keys.includes(key) || !memoryKeyForm(key)) continue;
    keys.push(key);
    if (keys.length === MAX_MEMORY_KEYS) break;
  }
  return keys;
}

export async function loadCardMemoryKeys(taskId: string): Promise<string[]> {
  const [row] = await db
    .select({
      number: taskTable.number,
      slug: projectTable.slug,
      backlogId: cardMetaTable.backlogId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);

  const queueItems = await db
    .select({ id: ownerApprovalTable.queueItemId })
    .from(ownerApprovalTable)
    .where(
      and(
        eq(ownerApprovalTable.targetId, taskId),
        isNotNull(ownerApprovalTable.queueItemId),
      ),
    )
    .orderBy(desc(ownerApprovalTable.createdAt))
    .limit(MAX_MEMORY_KEYS);

  const boardKey =
    row?.number != null ? `${row.slug.toUpperCase()}-${row.number}` : null;
  return orderMemoryKeys([
    taskId,
    boardKey,
    row?.backlogId,
    ...queueItems.map((item) => item.id),
  ]);
}
