import { and, eq, ilike, type SQL } from "drizzle-orm";
import db from "../../database";
import {
  projectTable,
  taskTable,
  userTable,
  workspaceTable,
} from "../../database/schema";
import { escapeLikePattern } from "../like-pattern";

/** The task with a short id such as "DEP-23" (moved from global-search.ts, TB-191). */
export function findTaskByShortId(
  slug: string,
  taskNumber: number,
  workspaceFilter: SQL | undefined,
  projectId?: string,
) {
  return db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      description: taskTable.description,
      projectId: taskTable.projectId,
      projectName: projectTable.name,
      projectSlug: projectTable.slug,
      workspaceId: projectTable.workspaceId,
      workspaceName: workspaceTable.name,
      userId: taskTable.userId,
      userName: userTable.name,
      createdAt: taskTable.createdAt,
      taskNumber: taskTable.number,
      priority: taskTable.priority,
      status: taskTable.status,
    })
    .from(taskTable)
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(
      and(
        workspaceFilter,
        projectId ? eq(taskTable.projectId, projectId) : undefined,
        // A project key may hold `_`, which `ilike` reads as "any one
        // character", so `DE_-23` would also match a task in `DEP` and the
        // `limit(1)` below would pick whichever came back first. Escaping
        // keeps the case-insensitive comparison and drops the wildcards.
        ilike(projectTable.slug, escapeLikePattern(slug)),
        eq(taskTable.number, taskNumber),
      ),
    )
    .limit(1);
}
