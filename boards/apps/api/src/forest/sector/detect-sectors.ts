import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import db from "../../database";
import { sectorTable, sectorTreeTable } from "../../database/forest-schema";
import { taskTable } from "../../database/schema";
import { groupSectors, type RootPair, sectorSignature } from "./group-sectors";
import { detectedSectorName, sectorName } from "./sector-name";

export const SECTOR_PAIR_LIMIT = 10_000;
const DETECTED_BY = "links-v1";

// v1 reads explicit blocks/related links between trees of one workspace.
// Shared decisions (comments citing the same decision) are a later signal.
async function linkedRootPairs(workspaceId: string): Promise<RootPair[]> {
  const result = await db.execute<{ a: string; b: string }>(sql`
    WITH RECURSIVE ws_task AS (
      SELECT t.id FROM task t
      JOIN project p ON p.id = t.project_id
      WHERE p.workspace_id = ${workspaceId}
    ),
    roots AS (
      SELECT w.id FROM ws_task w
      WHERE NOT EXISTS (
        SELECT 1 FROM task_relation r
        WHERE r.target_task_id = w.id AND r.relation_type = 'subtask'
      )
    ),
    tree(root_id, task_id) AS (
      SELECT id, id FROM roots
      UNION
      SELECT tree.root_id, r.target_task_id
      FROM task_relation r
      JOIN tree ON r.source_task_id = tree.task_id
      WHERE r.relation_type = 'subtask'
    )
    SELECT DISTINCT a.root_id AS a, b.root_id AS b
    FROM task_relation r
    JOIN tree a ON a.task_id = r.source_task_id
    JOIN tree b ON b.task_id = r.target_task_id
    WHERE r.relation_type IN ('blocks', 'related') AND a.root_id <> b.root_id
    LIMIT ${SECTOR_PAIR_LIMIT}
  `);
  return result.rows;
}

export type DetectedSector = {
  id: string;
  name: string;
  treeIds: string[];
  created: boolean;
};

// Recomputes the workspace's sectors: new groups are inserted, groups that
// no longer exist are marked stale, unchanged ones are left as they are.
export async function detectSectors(workspaceId: string) {
  const groups = groupSectors(await linkedRootPairs(workspaceId));
  const signatures = groups.map(sectorSignature);
  const rootIds = [...new Set(groups.flat())];
  const titles = rootIds.length
    ? await db
        .select({ id: taskTable.id, title: taskTable.title })
        .from(taskTable)
        .where(inArray(taskTable.id, rootIds))
    : [];
  const titleOf = new Map(titles.map((row) => [row.id, row.title]));

  return db.transaction(async (tx) => {
    await tx
      .update(sectorTable)
      .set({ status: "stale" })
      .where(
        and(
          eq(sectorTable.workspaceId, workspaceId),
          eq(sectorTable.status, "active"),
          eq(sectorTable.detectedBy, DETECTED_BY),
          signatures.length
            ? notInArray(sectorTable.signature, signatures)
            : undefined,
        ),
      );

    const sectors: DetectedSector[] = [];
    for (const [index, treeIds] of groups.entries()) {
      const signature = signatures[index] as string;
      const name = detectedSectorName(
        titleOf.get(treeIds[0] as string) ?? (treeIds[0] as string),
        treeIds.length,
      );
      const [inserted] = await tx
        .insert(sectorTable)
        .values({ workspaceId, name, detectedBy: DETECTED_BY, signature })
        .onConflictDoNothing()
        .returning({ id: sectorTable.id });
      if (inserted) {
        await tx
          .insert(sectorTreeTable)
          .values(treeIds.map((taskId) => ({ sectorId: inserted.id, taskId })));
        sectors.push({ id: inserted.id, name, treeIds, created: true });
        continue;
      }
      const [existing] = await tx
        .select({ id: sectorTable.id, name: sectorTable.name })
        .from(sectorTable)
        .where(
          and(
            eq(sectorTable.workspaceId, workspaceId),
            eq(sectorTable.signature, signature),
            eq(sectorTable.status, "active"),
          ),
        );
      if (existing) {
        sectors.push({
          id: existing.id,
          name: sectorName(existing.name),
          treeIds,
          created: false,
        });
      }
    }
    return sectors;
  });
}
