import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../database";
import { sectorTable, sectorTreeTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { sectorName } from "../sector/sector-name";

const DEPTH_MAX = 20;

// The card itself first, then its parent, up to the root: one parent per
// level (the oldest subtask link). The depth cap and the repeat check end a
// subtask cycle.
async function chainToRoot(taskId: string) {
  const result = await db.execute<{ task_id: string }>(sql`
    WITH RECURSIVE up(task_id, depth) AS (
      SELECT ${taskId}::text, 0
      UNION ALL
      SELECT p.parent_id, up.depth + 1
      FROM up
      CROSS JOIN LATERAL (
        SELECT r.source_task_id AS parent_id FROM task_relation r
        WHERE r.target_task_id = up.task_id AND r.relation_type = 'subtask'
        ORDER BY r.created_at, r.id
        LIMIT 1
      ) p
      WHERE up.depth < ${DEPTH_MAX}
    )
    SELECT task_id FROM up ORDER BY depth
  `);
  const chain: string[] = [];
  for (const { task_id } of result.rows) {
    if (chain.includes(task_id)) break;
    chain.push(task_id);
  }
  return chain;
}

// Subcards under a card at any depth that the caller can see, and how many
// of them sit in a final column of their own project.
async function countBelow(rootId: string, workspaceId: string, userId: string) {
  const result = await db.execute<{ total: string; done: string }>(sql`
    WITH RECURSIVE down(task_id) AS (
      SELECT ${rootId}::text
      UNION
      SELECT r.target_task_id FROM task_relation r
      JOIN down ON r.source_task_id = down.task_id
      WHERE r.relation_type = 'subtask'
    )
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "column" c
        WHERE c.project_id = t.project_id AND c.slug = t.status AND c.is_final
      )) AS done
    FROM down
    JOIN task t ON t.id = down.task_id
    JOIN project p ON p.id = t.project_id
    WHERE t.id <> ${rootId}
      AND p.workspace_id = ${workspaceId}
      AND ${projectAccessCondition(userId, sql`p.id`)}
  `);
  const [row] = result.rows;
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) };
}

// Where a card sits in the forest (d-tb-forest-in-cards): the path up to its
// tree's root, its subcards and the whole tree's progress, and the active
// sectors the tree belongs to. Parents in projects the caller cannot see are
// counted, not shown; a hidden root shows no sectors.
export async function getCardPlace(
  taskId: string,
  workspaceId: string,
  userId: string,
) {
  const chain = await chainToRoot(taskId);
  const rootId = chain.at(-1) ?? taskId;
  const parentIds = chain.slice(1).reverse();

  const [parents, below, tree] = await Promise.all([
    parentIds.length
      ? db
          .select({
            id: taskTable.id,
            number: taskTable.number,
            title: taskTable.title,
            projectId: taskTable.projectId,
            projectSlug: projectTable.slug,
          })
          .from(taskTable)
          .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
          .where(
            and(
              inArray(taskTable.id, parentIds),
              eq(projectTable.workspaceId, workspaceId),
              projectAccessCondition(userId, projectTable.id),
            ),
          )
      : [],
    countBelow(taskId, workspaceId, userId),
    rootId === taskId ? null : countBelow(rootId, workspaceId, userId),
  ]);
  const visible = new Map(parents.map((row) => [row.id, row]));
  const ancestors = parentIds.flatMap((id) => {
    const row = visible.get(id);
    return row ? [row] : [];
  });
  const rootVisible = rootId === taskId || visible.has(rootId);

  const sectorRows = rootVisible
    ? await db
        .select({ id: sectorTable.id, name: sectorTable.name })
        .from(sectorTreeTable)
        .innerJoin(sectorTable, eq(sectorTreeTable.sectorId, sectorTable.id))
        .where(
          and(
            eq(sectorTreeTable.taskId, rootId),
            eq(sectorTable.workspaceId, workspaceId),
            eq(sectorTable.status, "active"),
          ),
        )
        .orderBy(sectorTable.name)
    : [];
  const sectors = sectorRows.map((sector) => ({
    ...sector,
    name: sectorName(sector.name),
  }));

  return {
    rootId: rootVisible ? rootId : null,
    ancestors,
    hiddenAncestors: parentIds.length - ancestors.length,
    subcards: below,
    tree: tree ?? below,
    sectors,
  };
}
