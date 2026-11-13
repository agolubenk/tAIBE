import { eq } from "drizzle-orm";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";

export async function loadGuardedTask(taskId: string) {
  const [task] = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      description: taskTable.description,
      status: taskTable.status,
      columnId: taskTable.columnId,
      priority: taskTable.priority,
      revision: taskTable.revision,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, taskId))
    .limit(1);
  return task ?? null;
}

export async function projectWorkspace(projectId: string) {
  const [project] = await db
    .select({ workspaceId: projectTable.workspaceId })
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .limit(1);
  return project?.workspaceId ?? null;
}
