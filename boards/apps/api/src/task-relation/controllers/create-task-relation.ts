import { and, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertProjectAccess } from "../../project-access/assert-project-access";
import { wouldCloseSubtaskCycle } from "./subtask-cycle";
import { findSubtaskParent, lockSubtaskLinks } from "./subtask-parent";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Relation = typeof taskRelationTable.$inferSelect;
type ReplacedParent = { relation: Relation; projectId: string };

const SECOND_PARENT =
  "subtask_second_parent: the task already has a parent; send replaceParent to move it";

// A subtask link keeps the forest a forest: no cycle through any ancestor (E6)
// and one parent per card (E7). With replaceParent the card's current parent
// link is dropped in the same transaction, so a move never leaves it orphaned.
async function settleSubtaskLink(
  tx: Transaction,
  input: {
    parentId: string;
    childId: string;
    replaceParent: boolean;
    userId: string;
    workspaceId: string;
  },
): Promise<ReplacedParent | undefined> {
  // Two opposite links created at once would each pass the check alone;
  // one lock per workspace serializes subtask links (cheap: they are rare).
  await lockSubtaskLinks(tx, input.workspaceId);
  if (await wouldCloseSubtaskCycle(tx, input.parentId, input.childId)) {
    throw new HTTPException(409, {
      message:
        "subtask_cycle: the target is already this task's parent or ancestor",
    });
  }

  const current = await findSubtaskParent(tx, input.childId);
  if (!current) return undefined;
  if (!input.replaceParent || current.parentWorkspaceId !== input.workspaceId) {
    throw new HTTPException(409, { message: SECOND_PARENT });
  }
  await assertProjectAccess(input.userId, current.parentProjectId);
  const [relation] = await tx
    .delete(taskRelationTable)
    .where(eq(taskRelationTable.id, current.id))
    .returning();
  return relation
    ? { relation, projectId: current.parentProjectId }
    : undefined;
}

async function createTaskRelation({
  sourceTaskId,
  targetTaskId,
  relationType,
  replaceParent = false,
  userId,
  workspaceId,
}: {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  replaceParent?: boolean;
  userId: string;
  workspaceId: string;
}) {
  if (sourceTaskId === targetTaskId) {
    throw new HTTPException(400, {
      message: "Cannot create a relation between a task and itself",
    });
  }

  const { relation, sourceTask, prior } = await db.transaction(async (tx) => {
    // Serialize relation creation with project moves before validating either
    // workspace. A move must see this relation or this request must see the move.
    await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        inArray(
          projectTable.id,
          tx
            .select({ projectId: taskTable.projectId })
            .from(taskTable)
            .where(inArray(taskTable.id, [sourceTaskId, targetTaskId])),
        ),
      )
      .orderBy(projectTable.id)
      .for("share");
    const [sourceTask] = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(
        and(
          eq(taskTable.id, sourceTaskId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!sourceTask) {
      throw new HTTPException(404, { message: "Source task not found" });
    }

    const [targetTask] = await tx
      .select({
        id: taskTable.id,
        projectId: taskTable.projectId,
        workspaceId: projectTable.workspaceId,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(
        and(
          eq(taskTable.id, targetTaskId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!targetTask) {
      throw new HTTPException(404, { message: "Target task not found" });
    }

    await assertProjectAccess(userId, targetTask.projectId);

    const existing = await tx
      .select({ id: taskRelationTable.id })
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.relationType, relationType),
          or(
            and(
              eq(taskRelationTable.sourceTaskId, sourceTaskId),
              eq(taskRelationTable.targetTaskId, targetTaskId),
            ),
            and(
              eq(taskRelationTable.sourceTaskId, targetTaskId),
              eq(taskRelationTable.targetTaskId, sourceTaskId),
            ),
          ),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new HTTPException(409, {
        message: "This relation already exists",
      });
    }

    const prior =
      relationType === "subtask"
        ? await settleSubtaskLink(tx, {
            parentId: sourceTaskId,
            childId: targetTaskId,
            replaceParent,
            userId,
            workspaceId,
          })
        : undefined;

    const [relation] = await tx
      .insert(taskRelationTable)
      .values({
        sourceTaskId,
        targetTaskId,
        relationType,
      })
      .returning();

    if (!relation) {
      throw new HTTPException(500, {
        message: "Failed to create task relation",
      });
    }

    return { relation, sourceTask, prior };
  });

  if (prior) {
    await publishEvent("task-relation.deleted", {
      ...prior.relation,
      taskId: prior.relation.sourceTaskId,
      projectId: prior.projectId,
      userId,
    });
  }
  await publishEvent("task-relation.created", {
    ...relation,
    taskId: sourceTaskId,
    projectId: sourceTask.projectId,
    userId,
  });

  return relation;
}

export default createTaskRelation;
