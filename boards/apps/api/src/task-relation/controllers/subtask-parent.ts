import { sql } from "drizzle-orm";
import type db from "../../database";

type Executor = Pick<typeof db, "execute">;

// One parent per card (E7, decision 01.11): the tree, sectors and felling read
// a card's oldest subtask link, so a second one would sit there unseen.
// Subtask links of a workspace are written one at a time under this lock, so
// two requests cannot both find a card without a parent and both link it.
export async function lockSubtaskLinks(
  executor: Executor,
  workspaceId: string,
) {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`subtask:${workspaceId}`}))`,
  );
}

export type SubtaskParentLink = {
  id: string;
  parentId: string;
  parentProjectId: string;
  parentWorkspaceId: string;
};

// The link the tree reads: the oldest one, as in forest/tree/card-place.ts.
export async function findSubtaskParent(
  executor: Executor,
  childId: string,
): Promise<SubtaskParentLink | undefined> {
  const result = await executor.execute<{
    id: string;
    parent_id: string;
    parent_project_id: string;
    parent_workspace_id: string;
  }>(sql`
    SELECT r.id, r.source_task_id AS parent_id,
           t.project_id AS parent_project_id,
           p.workspace_id AS parent_workspace_id
    FROM task_relation r
    JOIN task t ON t.id = r.source_task_id
    JOIN project p ON p.id = t.project_id
    WHERE r.target_task_id = ${childId} AND r.relation_type = 'subtask'
    ORDER BY r.created_at, r.id
    LIMIT 1
  `);
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        parentId: row.parent_id,
        parentProjectId: row.parent_project_id,
        parentWorkspaceId: row.parent_workspace_id,
      }
    : undefined;
}

// Cards among childIds that already have a parent (for writers that link in bulk).
export async function childrenWithParent(
  executor: Executor,
  childIds: readonly string[],
): Promise<Set<string>> {
  if (childIds.length === 0) return new Set();
  const result = await executor.execute<{ target_task_id: string }>(sql`
    SELECT DISTINCT target_task_id FROM task_relation
    WHERE relation_type = 'subtask'
      AND target_task_id IN (${sql.join(
        childIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);
  return new Set(result.rows.map((row) => row.target_task_id));
}
