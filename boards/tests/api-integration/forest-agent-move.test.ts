import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

async function lease(forest: Forest, taskId: string) {
  const res = await forest.agent("/leases", { taskId }, "dev-1");
  expect(res.status).toBe(200);
  return String(res.body.fencingToken);
}

async function columnOf(projectId: string, slug: string) {
  const [column] = await db
    .select()
    .from(schema.columnTable)
    .where(
      and(
        eq(schema.columnTable.projectId, projectId),
        eq(schema.columnTable.slug, slug),
      ),
    );
  return column;
}

// A card in a status of its project. withColumn: false writes the status
// alone, as no route does (a forged final status).
async function placeTask(projectId: string, status: string, withColumn = true) {
  const task = await addTask(projectId, status);
  const column = withColumn ? await columnOf(projectId, status) : undefined;
  await db
    .update(schema.taskTable)
    .set({ status, columnId: column?.id ?? null })
    .where(eq(schema.taskTable.id, task.id));
  return task;
}

async function taskRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

// Another project of the workspace. Its final column is «finished», as
// Lavaeon's «завершённые»: there is no «done» there.
async function otherProject(forest: Forest) {
  const { project } = await createProjectFixture({
    workspaceId: forest.workspace.id,
    name: "Other",
  });
  await db
    .update(schema.columnTable)
    .set({ slug: "finished", name: "Finished" })
    .where(
      and(
        eq(schema.columnTable.projectId, project.id),
        eq(schema.columnTable.slug, "done"),
      ),
    );
  return project;
}

async function move(
  forest: Forest,
  taskId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const token = await lease(forest, taskId);
  return forest.agentApi(
    "PUT",
    `/task/move/${taskId}`,
    body,
    { "x-t-boards-fence": token, ...headers },
    "dev-1",
  );
}

async function expectRefused(
  forest: Forest,
  taskId: string,
  body: Record<string, unknown>,
  action: "close_task" | "reopen_task",
) {
  const before = await taskRow(taskId);
  const res = await move(forest, taskId, body);
  expect(res.status).toBe(403);
  expect(res.body.message).toContain("approval_required");
  expect(res.body.message).toContain(action);
  expect(res.body.message).toContain("its own project");
  const after = await taskRow(taskId);
  expect(after?.projectId).toBe(before?.projectId);
  expect(after?.status).toBe(before?.status);
}

describe("API integration: an agent moves a card to another project (TB-80)", () => {
  beforeEach(resetTestDatabase);

  it("moves a card from a final column into the other project's final column without a «да»", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const task = await placeTask(forest.project.id, "done");

    const res = await move(forest, task.id, {
      destinationProjectId: other.id,
      destinationStatus: "finished",
    });

    expect(res.status).toBe(200);
    const row = await taskRow(task.id);
    expect(row?.projectId).toBe(other.id);
    expect(row?.status).toBe("finished");
    expect(row?.columnId).toBe((await columnOf(other.id, "finished"))?.id);
  });

  it("still asks a «да» to move an open card into a final column, and spends none on the move", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const task = await placeTask(forest.project.id, "to-do");
    const body = {
      destinationProjectId: other.id,
      destinationStatus: "finished",
    };

    await expectRefused(forest, task.id, body, "close_task");
    // An approval id does not turn the move into a spend of a «да».
    const withId = await move(forest, task.id, body, {
      "x-t-boards-approval": "some-approval",
    });
    expect(withId.status).toBe(403);
    expect(withId.body.message).toContain("approval_required");
  });

  it("takes a closed card without a final column of its own as not closed", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const body = {
      destinationProjectId: other.id,
      destinationStatus: "finished",
    };

    // The status says «done», but no column backs it.
    const forged = await placeTask(forest.project.id, "done", false);
    await expectRefused(forest, forged.id, body, "close_task");
    // «archived» and the owner's «confirmation» have no final column.
    const archived = await placeTask(forest.project.id, "archived", false);
    await expectRefused(forest, archived.id, body, "close_task");
    const confirmation = await placeTask(forest.project.id, "confirmation");
    await expectRefused(forest, confirmation.id, body, "close_task");
    // «Брёвна» stay terminal (R-8).
    const logs = await placeTask(forest.project.id, "closed");
    await expectRefused(forest, logs.id, body, "close_task");
  });

  it("asks a «да» for a move that reopens a card, with no status or the same slug", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const done = await placeTask(forest.project.id, "done");

    // No «done» in the other project: the card would land in its first column.
    await expectRefused(
      forest,
      done.id,
      { destinationProjectId: other.id },
      "reopen_task",
    );

    // The same slug, but open in the other project.
    const third = await createProjectFixture({
      workspaceId: forest.workspace.id,
      name: "Third",
    });
    await db
      .update(schema.columnTable)
      .set({ isFinal: false })
      .where(eq(schema.columnTable.id, third.columns.done.id));
    await expectRefused(
      forest,
      done.id,
      { destinationProjectId: third.project.id, destinationStatus: "done" },
      "reopen_task",
    );
  });
});
