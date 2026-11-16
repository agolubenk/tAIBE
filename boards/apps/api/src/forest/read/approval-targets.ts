import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { sectorTable } from "../../database/forest-schema";
import { projectTable, taskTable } from "../../database/schema";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { sectorName } from "../sector/sector-name";

export type ApprovalTarget = {
  title: string;
  number: number | null;
  projectId: string | null;
  projectName: string | null;
};

const targetKey = (targetType: string, targetId: string) =>
  `${targetType}:${targetId}`;

// What each request is about, in words the owner can check before saying
// «да». A card in a project the caller cannot open stays unnamed (null).
export async function loadApprovalTargets(
  items: readonly { targetType: string; targetId: string }[],
  workspaceId: string,
  userId: string,
) {
  const ids = (type: string) => [
    ...new Set(
      items
        .filter((item) => item.targetType === type)
        .map((item) => item.targetId),
    ),
  ];
  const taskIds = ids("task");
  const sectorIds = ids("sector");

  const [tasks, sectors] = await Promise.all([
    taskIds.length
      ? db
          .select({
            id: taskTable.id,
            number: taskTable.number,
            title: taskTable.title,
            projectId: taskTable.projectId,
            projectName: projectTable.name,
          })
          .from(taskTable)
          .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
          .where(
            and(
              inArray(taskTable.id, taskIds),
              eq(projectTable.workspaceId, workspaceId),
              projectAccessCondition(userId, projectTable.id),
            ),
          )
      : [],
    sectorIds.length
      ? db
          .select({ id: sectorTable.id, name: sectorTable.name })
          .from(sectorTable)
          .where(
            and(
              inArray(sectorTable.id, sectorIds),
              eq(sectorTable.workspaceId, workspaceId),
            ),
          )
      : [],
  ]);

  const targets = new Map<string, ApprovalTarget>();
  for (const { id, ...task } of tasks) {
    targets.set(targetKey("task", id), task);
  }
  for (const sector of sectors) {
    targets.set(targetKey("sector", sector.id), {
      title: sectorName(sector.name),
      number: null,
      projectId: null,
      projectName: null,
    });
  }
  return (item: { targetType: string; targetId: string }) =>
    targets.get(targetKey(item.targetType, item.targetId)) ?? null;
}
