import type db from "../../database";
import { taskRelationTable } from "../../database/schema";
import {
  childrenWithParent,
  lockSubtaskLinks,
} from "../../task-relation/controllers/subtask-parent";
import { chunk } from "./chunk";
import type { PlannedImportRelation } from "./plan-import-relations";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function writeImportRelations(
  tx: Transaction,
  workspaceId: string,
  relations: readonly PlannedImportRelation[],
): Promise<number> {
  const writable = await withoutSecondParents(tx, workspaceId, relations);
  for (const batch of chunk(writable)) {
    await tx.insert(taskRelationTable).values(batch);
  }
  return writable.length;
}

// A re-import can link a card that already has a parent on the board (a
// mirrored card under a new page): that card keeps the parent it has (E7).
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
