import type { ImportedProject, ImportSourceId } from "@kaneo/importers";
import { createId } from "@paralleldrive/cuid2";
import { eq, sql } from "drizzle-orm";
import type db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import type { ImportCounts } from "../import-run-project";
import { loadAssignableMembers } from "../writer/load-assignable-members";
import { createAssigneeMatcher } from "../writer/match-assignees";
import { planImportColumns } from "../writer/plan-import-columns";
import { planImportRelations } from "../writer/plan-import-relations";
import {
  type PlannedImportTask,
  planImportTasks,
} from "../writer/plan-import-tasks";
import { writeImportComments } from "../writer/write-import-comments";
import { writeImportLabels } from "../writer/write-import-labels";
import { writeImportRelations } from "../writer/write-import-relations";
import { writeImportTasks } from "../writer/write-import-tasks";
import { ensureSyncColumns } from "./ensure-sync-columns";
import {
  type CurrentPlacement,
  loadNumbering,
  loadPlacements,
  loadPositionAllocator,
} from "./load-sync-state";
import { notionMetaRows } from "./notion-meta-rows";
import { type NotionSyncPlan, numberFreshTasks } from "./plan-notion-sync";
import { writeNotionCardMeta } from "./write-notion-card-meta";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SyncNotionProjectInput = {
  projectId: string;
  workspaceId: string;
  userId: string;
  source: ImportSourceId;
  project: ImportedProject;
  includeComments: boolean;
  plan: NotionSyncPlan;
  // Keys of pages whose Backlog ID stays in the footer only.
  backlogDropped: ReadonlySet<string>;
};

// A re-import of a mirrored database (R-080): edited pages rewrite their
// cards, new pages join the project, nothing is deleted. Labels and relations
// of cards that already existed stay as they are.
export async function syncNotionProject(
  tx: Transaction,
  input: SyncNotionProjectInput,
): Promise<{ counts: ImportCounts; warnings: string[] }> {
  const { projectId, workspaceId, userId, project, plan } = input;
  const now = new Date();
  const board = await ensureSyncColumns(tx, projectId, project.columns);
  const assignees = createAssigneeMatcher(
    await loadAssignableMembers(tx, workspaceId, projectId),
  );
  const nextPosition = await loadPositionAllocator(tx, projectId);
  const planTasks = (tasks: typeof project.tasks, numbers: number[]) =>
    planImportTasks({
      tasks,
      columns: board.byKey,
      fallbackColumn: board.fallback,
      numbers,
      now,
      newId: createId,
      assign: assignees.match,
    });

  // Planned like new tasks for placement and fields, then given the card's id.
  const changed = planTasks(
    plan.changed.map(({ task }) => task),
    plan.changed.map(() => 0),
  ).flatMap((task, index) => {
    const taskId = plan.changed[index]?.taskId;
    return taskId ? [{ ...task, id: taskId }] : [];
  });
  const placements = await loadPlacements(
    tx,
    changed.map(({ id }) => id),
  );
  for (const task of changed) {
    await updateMirroredTask(tx, task, placements.get(task.id), {
      projectId,
      nextPosition,
    });
  }

  const numbering = await loadNumbering(
    tx,
    projectId,
    plan.fresh.map(({ number }) => number),
  );
  const { numbers, lastNumber } = numberFreshTasks(
    plan.fresh.map(({ number }) => number),
    numbering.taken,
    numbering.lastTaskNumber,
  );
  if (lastNumber > numbering.lastTaskNumber) {
    await tx
      .update(projectTable)
      .set({
        lastTaskNumber: sql`GREATEST(${projectTable.lastTaskNumber}, ${lastNumber})`,
      })
      .where(eq(projectTable.id, projectId));
  }
  const fresh = planTasks(plan.fresh, numbers).map((task) => ({
    ...task,
    position: nextPosition(task),
  }));
  await writeImportTasks(tx, projectId, userId, fresh);
  const labels = await writeImportLabels(
    tx,
    workspaceId,
    project.labels,
    fresh,
  );
  const comments = input.includeComments
    ? await writeImportComments(tx, {
        tasks: fresh,
        importedBy: userId,
        source: input.source,
        now,
      })
    : 0;

  const freshIds = new Set(fresh.map(({ id }) => id));
  const taskIds = new Map([
    ...plan.mirrored,
    ...fresh.map((task): [string, string] => [task.key, task.id]),
  ]);
  const relations = await writeImportRelations(
    tx,
    planImportRelations(project.relations, taskIds).filter(
      (relation) =>
        freshIds.has(relation.sourceTaskId) ||
        freshIds.has(relation.targetTaskId),
    ),
  );

  const metaChanged = await writeNotionCardMeta(tx, {
    workspaceId,
    userId,
    rows: notionMetaRows(
      [...plan.changed.map(({ task }) => task), ...plan.fresh],
      taskIds,
      input.backlogDropped,
    ),
  });

  const unmatched = assignees.warning();
  const written = [...changed, ...fresh];
  return {
    counts: {
      columns: board.count,
      tasks: written.length,
      labels,
      comments,
      assignees: written.filter((task) => task.userId).length,
      relations,
    },
    warnings: [
      `Notion mirror: ${fresh.length} new, ${changed.length} updated, ${plan.unchanged} unchanged, ${metaChanged} with changed meta.`,
      ...project.warnings,
      ...planImportColumns(project.columns).warnings,
      ...(unmatched ? [unmatched] : []),
    ],
  };
}

async function updateMirroredTask(
  tx: Transaction,
  task: PlannedImportTask,
  current: CurrentPlacement | undefined,
  board: {
    projectId: string;
    nextPosition: (task: PlannedImportTask) => number;
  },
) {
  // A card moved to another project keeps its place there: this project's
  // columns mean nothing on that board.
  const sameBoard = current?.projectId === board.projectId;
  const moved =
    sameBoard &&
    (current.status !== task.status || current.columnId !== task.columnId);
  await tx
    .update(taskTable)
    .set({
      title: task.title,
      description: task.description,
      priority: task.priority,
      startDate: task.startDate,
      dueDate: task.dueDate,
      ...(moved
        ? {
            status: task.status,
            columnId: task.columnId,
            position: board.nextPosition(task),
          }
        : {}),
      ...(task.userId ? { userId: task.userId } : {}),
    })
    .where(eq(taskTable.id, task.id));
}
