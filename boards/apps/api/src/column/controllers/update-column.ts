import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { getProjectSubtaskParentProjects } from "../../task/get-subtask-parent-projects";

async function updateColumn(
  id: string,
  data: {
    name?: string;
    icon?: string | null;
    color?: string | null;
    isFinal?: boolean;
  },
) {
  const existing = await db.query.columnTable.findFirst({
    where: eq(columnTable.id, id),
  });

  if (!existing) {
    throw new HTTPException(404, { message: "Column not found" });
  }

  const [updated] = await db
    .update(columnTable)
    .set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.icon !== undefined && { icon: data.icon }),
      ...(data.color !== undefined && { color: data.color }),
      ...(data.isFinal !== undefined && { isFinal: data.isFinal }),
    })
    .where(eq(columnTable.id, id))
    .returning();

  if (!updated) {
    throw new HTTPException(500, { message: "Failed to update column" });
  }

  const completionChanged = existing.isFinal !== updated.isFinal;
  if (completionChanged) {
    const parents = await getProjectSubtaskParentProjects(
      updated.projectId,
      updated.slug,
    );
    await publishEvent("subtask-parents.refresh", {
      projects: [
        { projectId: updated.projectId },
        ...parents.filter((p) => p.projectId !== updated.projectId),
      ],
    });
  }

  // The database trigger has just set or cleared completed_at on this column's
  // tasks; open cards refetch only on this hint (TB-30).
  await publishEvent("project.updated", {
    projectId: updated.projectId,
    ...(completionChanged ? { completionChanged: true } : {}),
  });

  return updated;
}

export default updateColumn;
