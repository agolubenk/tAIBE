import { and, desc, eq } from "drizzle-orm";
import db from "../database";
import { ssrConflictTable } from "../database/ssr-schema";

// Push-back conflicts of one workspace (RU-9, D-012), newest first.
export async function listConflicts(workspaceId: string) {
  const rows = await db
    .select()
    .from(ssrConflictTable)
    .where(eq(ssrConflictTable.workspaceId, workspaceId))
    .orderBy(desc(ssrConflictTable.detectedAt))
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    baselineSha: row.baselineSha,
    repoSha: row.repoSha,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }));
}

// The route authorized one workspace, so the update matches only that
// workspace's rows: a conflict id from another workspace changes nothing
// (TB-85). False means no such conflict here.
export async function resolveConflict(
  workspaceId: string,
  conflictId: string,
): Promise<boolean> {
  const rows = await db
    .update(ssrConflictTable)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(
      and(
        eq(ssrConflictTable.id, conflictId),
        eq(ssrConflictTable.workspaceId, workspaceId),
      ),
    )
    .returning({ id: ssrConflictTable.id });
  return rows.length > 0;
}
