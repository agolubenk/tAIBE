import type db from "../../database";
import { taskRelationTable } from "../../database/schema";
import {
  childrenWithParent,
  lockSubtaskLinks,
} from "../../task-relation/controllers/subtask-parent";
import { chunk } from "./chunk";
import type { PlannedImportRelation } from "./plan-import-relations";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type WrittenImportRelations = {
  written: number;
  // Subtask links not written: the card already had a parent on the board.
  keptParent: number;
};

// `onBoard`: some of the cards were on the board before this import (a
// re-import), so they may have a parent already. Without it every card is new
// to this transaction: none has a parent and no other request can see them
// before the commit, so neither the lock nor the lookup is needed.
export async function writeImportRelations(
  tx: Transaction,
  relations: readonly PlannedImportRelation[],
  onBoard?: { workspaceId: string },
): Promise<WrittenImportRelations> {
  const writable = onBoard
    ? await withoutSecondParents(tx, onBoard.workspaceId, relations)
    : relations;
  for (const batch of chunk(writable)) {
    await tx.insert(taskRelationTable).values(batch);
  }
  return {
    written: writable.length,
    keptParent: relations.length - writable.length,
  };
}

// A re-import can link a card that already has a parent on the board (a
// mirrored card under a new page): that card keeps the parent it has (E7).
// The lock holds until the commit, so the caller writes these links last.
async function withoutSecondParents(
  tx: Transaction,
  workspaceId: string,
  relations: readonly PlannedImportRelation[],
) {
  const children = relations
    .filter((relation) => relation.relationType === "subtask")
    .map((relation) => relation.targetTaskId);
  if (children.length === 0) return relations;
  await lockSubtaskLinks(tx, workspaceId);
  const parented = new Set<string>();
  for (const ids of chunk(children)) {
    for (const id of await childrenWithParent(tx, ids)) parented.add(id);
  }
  return relations.filter(
    (relation) =>
      relation.relationType !== "subtask" ||
      !parented.has(relation.targetTaskId),
  );
}
