import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { addTask, approve, createForest } from "./helpers/forest";

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

async function columnIdOf(projectId: string, slug: string) {
  const column = await columnOf(projectId, slug);
  if (!column) throw new Error(`no «${slug}» column in ${projectId}`);
  return column.id;
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

// A refused move writes nothing, and its answer names the way round.
async function expectRefused(
  forest: Forest,
  taskId: string,
  body: Record<string, unknown>,
  action: "close_task" | "reopen_task",
  route: string,
) {
  const before = await taskRow(taskId);
  const res = await move(forest, taskId, body);
  expect(res.status).toBe(403);
  expect(res.body.message).toContain("approval_required");
  expect(res.body.message).toContain(`ask ${action}`);
  expect(res.body.message).toContain(route);
  expect(res.body.message).toContain("a move never spends one");
  const after = await taskRow(taskId);
  expect(after?.projectId).toBe(before?.projectId);
  expect(after?.status).toBe(before?.status);
}

const OPEN_FIRST = "into an open column of the destination first";
const CLOSE_HOME = "in its own project with a final status of that project";
const REOPEN_HOME = "reopen_task in its own project";

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

    await expectRefused(forest, task.id, body, "close_task", OPEN_FIRST);
    // An approval id does not turn the move into a spend of a «да».
    const withId = await move(forest, task.id, body, {
      "x-t-boards-approval": "some-approval",
    });
    expect(withId.status).toBe(403);
    expect(withId.body.message).toContain("approval_required");
  });

  it("sends a closed card without a final column through its own project; «Брёвна» do not move", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const body = {
      destinationProjectId: other.id,
      destinationStatus: "finished",
    };

    // The status says «done», but no column backs it.
    const forged = await placeTask(forest.project.id, "done", false);
    await expectRefused(forest, forged.id, body, "close_task", CLOSE_HOME);
    // «archived» and the owner's «confirmation» have no final column.
    const archived = await placeTask(forest.project.id, "archived", false);
    await expectRefused(forest, archived.id, body, "close_task", CLOSE_HOME);
    const confirmation = await placeTask(forest.project.id, "confirmation");
    await expectRefused(
      forest,
      confirmation.id,
      body,
      "close_task",
      CLOSE_HOME,
    );
    // «Брёвна» stay terminal (R-8): no «да» helps, so none is asked.
    const logs = await placeTask(forest.project.id, "closed");
    for (const destinationStatus of ["finished", "closed", "new"]) {
      const res = await move(forest, logs.id, {
        destinationProjectId: other.id,
        destinationStatus,
      });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("agent_forbidden");
      expect(res.body.message).toContain("terminal");
    }
    expect((await taskRow(logs.id))?.projectId).toBe(forest.project.id);
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
      REOPEN_HOME,
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
      REOPEN_HOME,
    );
  });

  // TB-82 (moved here from #196): every route the guard names is walkable,
  // each «да» applied by the server in the card's current project.
  it("follows the way round the guard names, with the owner's «да» at each step", async () => {
    const forest = await createForest();
    const other = await otherProject(forest);
    const finished = (await columnOf(other.id, "finished"))?.id;

    // Reopen: the «да» in its own project, then an open move.
    const done = await placeTask(forest.project.id, "done");
    await expectRefused(
      forest,
      done.id,
      { destinationProjectId: other.id },
      "reopen_task",
      REOPEN_HOME,
    );
    await approve(forest, "reopen_task", done.id, "to-do");
    expect(
      (await move(forest, done.id, { destinationProjectId: other.id })).status,
    ).toBe(200);
    expect(await taskRow(done.id)).toMatchObject({
      projectId: other.id,
      status: "to-do",
    });

    // Close: an open move, then the «да» in the destination.
    const open = await placeTask(forest.project.id, "in-progress");
    const toFinished = {
      destinationProjectId: other.id,
      destinationStatus: "finished",
    };
    await expectRefused(forest, open.id, toFinished, "close_task", OPEN_FIRST);
    const opened = await move(forest, open.id, {
      destinationProjectId: other.id,
      destinationStatus: "in-progress",
    });
    expect(opened.status).toBe(200);
    await approve(forest, "close_task", open.id, "finished");
    expect(await taskRow(open.id)).toMatchObject({
      projectId: other.id,
      status: "finished",
      columnId: finished,
    });

    // A closing stage: the «да» to a final column at home, then a free move.
    const confirming = await placeTask(forest.project.id, "confirmation");
    await expectRefused(
      forest,
      confirming.id,
      toFinished,
      "close_task",
      CLOSE_HOME,
    );
    await approve(forest, "close_task", confirming.id, "done");
    expect((await move(forest, confirming.id, toFinished)).status).toBe(200);
    expect(await taskRow(confirming.id)).toMatchObject({
      projectId: other.id,
      status: "finished",
      columnId: finished,
    });

    // Into the destination's closing stage: a free move into its final
    // column, then the «да» there.
    const closed = await placeTask(forest.project.id, "done");
    await expectRefused(
      forest,
      closed.id,
      { destinationProjectId: other.id, destinationStatus: "confirmation" },
      "close_task",
      "move it into a final column of the destination, then ask close_task in the destination for «confirmation»",
    );
    expect((await move(forest, closed.id, toFinished)).status).toBe(200);
    await approve(forest, "close_task", closed.id, "confirmation");
    expect(await taskRow(closed.id)).toMatchObject({
      projectId: other.id,
      status: "confirmation",
    });
  });

  // TB-82 (moved here from #196): moves that leave the card as it was.
  it("lets a move that keeps the card open, or closed in a final column", async () => {
    const forest = await createForest();
    const fresh = async () =>
      (await createProjectFixture({ workspaceId: forest.workspace.id }))
        .project;

    // No «to-do» there: the card lands in the first column, open.
    const noTodo = await fresh();
    await db
      .delete(schema.columnTable)
      .where(eq(schema.columnTable.id, await columnIdOf(noTodo.id, "to-do")));
    const open = await placeTask(forest.project.id, "to-do");
    expect(
      (await move(forest, open.id, { destinationProjectId: noTodo.id })).status,
    ).toBe(200);
    expect(await taskRow(open.id)).toMatchObject({
      projectId: noTodo.id,
      status: "new",
    });

    // «done» is final at home but open there: the card stays open.
    const openDone = await fresh();
    await db
      .update(schema.columnTable)
      .set({ isFinal: false })
      .where(eq(schema.columnTable.id, await columnIdOf(openDone.id, "done")));
    const working = await placeTask(forest.project.id, "to-do");
    const lands = await move(forest, working.id, {
      destinationProjectId: openDone.id,
      destinationStatus: "done",
    });
    expect(lands.status).toBe(200);
    expect(await taskRow(working.id)).toMatchObject({
      projectId: openDone.id,
      status: "done",
    });

    // A card in a final column keeps its slug, final there too.
    const same = await fresh();
    const done = await placeTask(forest.project.id, "done");
    expect(
      (await move(forest, done.id, { destinationProjectId: same.id })).status,
    ).toBe(200);
    expect(await taskRow(done.id)).toMatchObject({
      projectId: same.id,
      status: "done",
      columnId: (await columnOf(same.id, "done"))?.id,
    });
  });

  // TB-82 (moved here from #196): the guard reads no columns of a project in
  // another workspace, so its answer tells nothing about them; move-task 404.
  it("leaves a move into another workspace to move-task's 404", async () => {
    const forest = await createForest();
    const foreign = await createForest();
    const done = await placeTask(forest.project.id, "done");
    for (const destinationStatus of [undefined, "to-do", "done", "missing"]) {
      const res = await move(forest, done.id, {
        destinationProjectId: foreign.project.id,
        destinationStatus,
      });
      expect(res.status).toBe(404);
    }
    expect(await taskRow(done.id)).toMatchObject({
      projectId: forest.project.id,
      status: "done",
    });
  });
});
