import {
  type CardMemoryKeyResult,
  MAX_MEMORY_KEYS,
  memoryKeyForm,
} from "@kaneo/claude-mem-reader";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import db from "../../database";
import {
  cardMetaTable,
  ownerApprovalTable,
} from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import type { CardMemory } from "./find-card-memory";

// Where a key comes from: the card's id, its board key, its Backlog ID or an
// owner-queue item of its «да» requests. The answer is labelled by it, not by
// the key's form: a Backlog ID «R-036» has a board key's form and is still
// shown as a Backlog ID (TB-121).
export type MemoryKeySource = "id" | "key" | "backlog" | "queue";

export type MemoryKey = { key: string; source: MemoryKeySource };

type Candidate = [string | null | undefined, MemoryKeySource];

// What a card's memory is searched by (TB-113, C-1/C-2): its id, its board key
// (TB-108), its Backlog ID and the owner-queue items of its «да» requests,
// newest first. Keys outside the forms the Mac proxy accepts are left out — a
// project key in Cyrillic, a lowercase Backlog ID — and the branch is not a
// key in v1: «main» names thousands of other observations. A key named twice
// keeps its first source.
export function orderMemoryKeys(candidates: Candidate[]): MemoryKey[] {
  const keys: MemoryKey[] = [];
  for (const [key, source] of candidates) {
    if (!key || keys.some((known) => known.key === key)) continue;
    if (!memoryKeyForm(key)) continue;
    keys.push({ key, source });
    if (keys.length === MAX_MEMORY_KEYS) break;
  }
  return keys;
}

type LabelledKeyResult = Omit<CardMemoryKeyResult, "matchedOn"> & {
  matchedOn: MemoryKeySource;
};

export type LabelledCardMemory = Omit<CardMemory, "keys"> & {
  keys: LabelledKeyResult[];
};

// The proxy labels a key by its form; the API knows where it came from.
export function labelBySource(
  memory: CardMemory,
  keys: MemoryKey[],
): LabelledCardMemory {
  const sources = new Map(keys.map(({ key, source }) => [key, source]));
  return {
    ...memory,
    keys: memory.keys.map((result) => ({
      ...result,
      matchedOn: sources.get(result.key) ?? result.matchedOn,
    })),
  };
}

export async function loadCardMemoryKeys(taskId: string): Promise<MemoryKey[]> {
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
    [taskId, "id"],
    [boardKey, "key"],
    [row?.backlogId, "backlog"],
    ...queueItems.map((item): Candidate => [item.id, "queue"]),
  ]);
}
