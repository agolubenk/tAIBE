import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { seedTable, treeOriginTable } from "../../database/forest-schema";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { insertProject } from "../../project/controllers/insert-project";
import { claimTaskNumber } from "../../task/controllers/claim-task-numbers";
import { nextTaskPosition } from "../../task/controllers/next-task-position";
import type { ForestActor } from "../actor";
import { authorOfActor } from "../author-kind";
import { writeJournal } from "../journal";

export const GROW_SEED_LIMIT = 100;
const START_STATUS = "to-do";

export type GrowInput = {
  workspaceId: string;
  actor: ForestActor;
  seedIds: string[];
  name: string;
  slug: string;
  icon?: string;
};

// A new forest starts from seeds: one tree per seed, each remembering the
// seed and log it came from. Felled trees themselves never come back (I7).
export async function growForest(input: GrowInput) {
  const seedIds = [...new Set(input.seedIds)];
  if (seedIds.length === 0 || seedIds.length > GROW_SEED_LIMIT) {
    throw new HTTPException(400, {
      message: `grow takes 1 to ${GROW_SEED_LIMIT} seeds`,
    });
  }

  const outcome = await db.transaction(async (tx) => {
    const seeds = await tx
      .select({
        id: seedTable.id,
        logId: seedTable.logId,
        title: seedTable.title,
        body: seedTable.body,
      })
      .from(seedTable)
      .where(
        and(
          inArray(seedTable.id, seedIds),
          eq(seedTable.workspaceId, input.workspaceId),
        ),
      );
    if (seeds.length !== seedIds.length) {
      throw new HTTPException(404, { message: "Seed not found" });
    }
    const order = new Map(seedIds.map((id, index) => [id, index]));
    seeds.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

    const project = await insertProject(tx, {
      workspaceId: input.workspaceId,
      name: input.name,
      icon: input.icon ?? "Layout",
      slug: input.slug,
      userId: input.actor.userId,
    });
    if (!project) throw new Error("project insert returned nothing");
    const [column] = await tx
      .select({ id: columnTable.id })
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, project.id),
          eq(columnTable.slug, START_STATUS),
        ),
      );

    const tasks = [];
    for (const seed of seeds) {
      const number = await claimTaskNumber(project.id, tx);
      const position = await nextTaskPosition(
        tx,
        project.id,
        START_STATUS,
        column?.id ?? null,
      );
      const [task] = await tx
        .insert(taskTable)
        .values({
          projectId: project.id,
          title: seed.title,
          description: seed.body,
          status: START_STATUS,
          columnId: column?.id ?? null,
          priority: "no-priority",
          number,
          position,
        })
        .returning();
      if (!task) throw new Error("task insert returned nothing");
      await tx
        .insert(treeOriginTable)
        .values({ taskId: task.id, seedId: seed.id, logId: seed.logId });
      tasks.push(task);
    }

    await writeJournal(
      {
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: "grow_forest",
        targetType: "project",
        targetId: project.id,
        outcome: "allowed",
        detail: `${tasks.length} tree(s) from seeds`,
      },
      tx,
    );
    return { project, tasks };
  });

  for (const task of outcome.tasks) {
    await publishEvent("task.created", {
      ...task,
      taskId: task.id,
      userId: task.userId ?? "",
      currentUserId: input.actor.userId,
      author: authorOfActor(input.actor),
      type: "created",
      content: null,
    });
  }

  return {
    projectId: outcome.project.id,
    taskIds: outcome.tasks.map((task) => task.id),
  };
}
