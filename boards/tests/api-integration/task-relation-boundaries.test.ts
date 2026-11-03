import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { writeImportRelations } from "../../apps/api/src/import/writer/write-import-relations";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { readErrorBody } from "./helpers/error-body";

const m = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));
vi.mock("../../apps/api/src/events", async (original) => ({
  ...(await original<object>()),
  publishEvent: m.publish,
}));
beforeEach(async () => {
  await resetTestDatabase();
  vi.clearAllMocks();
});
async function context() {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Private title", number: 1 })
    .returning();
  return { ...member, task };
}
function request(path: string, method: string, body?: unknown) {
  return createApp().app.request(`/api/task-relation${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}
async function seedRelation(sourceTaskId: string, targetTaskId: string) {
  const [relation] = await db
    .insert(schema.taskRelationTable)
    .values({ sourceTaskId, targetTaskId, relationType: "blocks" })
    .returning();
  return relation;
}

describe("task relation tenant boundaries", () => {
  it("rejects a foreign target and a nonexistent target identically", async () => {
    const own = await context();
    const foreign = await context();
    mockAuthenticatedSession(own.user);
    for (const targetTaskId of [foreign.task.id, "missing-task"]) {
      const response = await request("", "POST", {
        sourceTaskId: own.task.id,
        targetTaskId,
        relationType: "blocks",
      });
      expect(response.status).toBe(404);
      expect(await readErrorBody(response)).toMatchObject({
        message: "Target task not found",
        code: "NOT_FOUND",
      });
    }
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(0);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "hides legacy cross-workspace relations from reads in either direction (reverse=%s)",
    async (reverse) => {
      const own = await context();
      const foreign = await context();
      await seedRelation(
        reverse ? foreign.task.id : own.task.id,
        reverse ? own.task.id : foreign.task.id,
      );
      for (const member of [own, foreign]) {
        mockAuthenticatedSession(member.user);
        const response = await request(`/${member.task.id}`, "GET");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
      }
    },
  );

  it("rejects deletion of a legacy foreign-target row without mutation or event", async () => {
    const own = await context();
    const foreign = await context();
    const relation = await seedRelation(own.task.id, foreign.task.id);
    mockAuthenticatedSession(own.user);
    const response = await request(`/${relation.id}`, "DELETE");
    expect(response.status).toBe(404);
    expect(await readErrorBody(response)).toMatchObject({
      message: "Task relation not found",
      code: "NOT_FOUND",
    });
    expect(
      await db.query.taskRelationTable.findFirst({
        where: eq(schema.taskRelationTable.id, relation.id),
      }),
    ).toBeDefined();
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("requires source-workspace access for deletion even when the target is owned", async () => {
    const own = await context();
    const foreign = await context();
    const relation = await seedRelation(foreign.task.id, own.task.id);
    mockAuthenticatedSession(own.user);
    const response = await request(`/${relation.id}`, "DELETE");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Task relation not found");
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(1);
    expect(m.publish).not.toHaveBeenCalled();
  });

  it("keeps same-workspace cross-project relations fully usable", async () => {
    const own = await context();
    const { project } = await createProjectFixture({
      workspaceId: own.workspace.id,
    });
    const [target] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Related", number: 1 })
      .returning();
    mockAuthenticatedSession(own.user);
    const created = await request("", "POST", {
      sourceTaskId: own.task.id,
      targetTaskId: target.id,
      relationType: "related",
    });
    expect(created.status).toBe(200);
    const relation = (await created.json()) as { id: string };
    for (const task of [own.task, target]) {
      const response = await request(`/${task.id}`, "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        {
          id: relation.id,
          sourceTask: { id: own.task.id },
          targetTask: { id: target.id },
        },
      ]);
    }
    expect((await request(`/${relation.id}`, "DELETE")).status).toBe(200);
    expect(await db.query.taskRelationTable.findMany()).toHaveLength(0);
    expect(m.publish).toHaveBeenCalledWith(
      "task-relation.deleted",
      expect.objectContaining({
        sourceTaskId: own.task.id,
        targetTaskId: target.id,
      }),
    );
  });
});

describe("subtask links stay a forest", () => {
  async function addCard(projectId: string, title: string) {
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId, title, number: null })
      .returning();
    return task;
  }

  it("refuses a subtask link that would close a cycle through any ancestor", async () => {
    const own = await context();
    mockAuthenticatedSession(own.user);
    const a = own.task;
    const b = await addCard(a.projectId, "B");
    const c = await addCard(a.projectId, "C");
    const link = (
      sourceTaskId: string,
      targetTaskId: string,
      relationType = "subtask",
    ) => request("", "POST", { sourceTaskId, targetTaskId, relationType });

    expect((await link(a.id, b.id)).status).toBe(200);
    expect((await link(b.id, c.id)).status).toBe(200);

    // The reversed pair was already refused as a duplicate of the same link.
    expect((await link(b.id, a.id)).status).toBe(409);
    // A cycle through an ancestor is what the duplicate check missed.
    const deep = await link(c.id, a.id);
    expect(deep.status).toBe(409);
    expect((await readErrorBody(deep)).message).toContain("subtask_cycle");

    // Other relation types are not tree edges and stay allowed.
    expect((await link(c.id, a.id, "related")).status).toBe(200);
    const subtasks = await db
      .select()
      .from(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.relationType, "subtask"));
    expect(subtasks).toHaveLength(2);
  });

  async function subtaskLinks() {
    return (
      await db
        .select({
          sourceTaskId: schema.taskRelationTable.sourceTaskId,
          targetTaskId: schema.taskRelationTable.targetTaskId,
        })
        .from(schema.taskRelationTable)
        .where(eq(schema.taskRelationTable.relationType, "subtask"))
    ).map((row) => `${row.sourceTaskId}>${row.targetTaskId}`);
  }

  it("refuses a second parent and moves the card with replaceParent (E7)", async () => {
    const own = await context();
    mockAuthenticatedSession(own.user);
    const a = own.task;
    const b = await addCard(a.projectId, "B");
    const c = await addCard(a.projectId, "C");
    const parent = (parentId: string, childId: string, replaceParent?: true) =>
      request("", "POST", {
        sourceTaskId: parentId,
        targetTaskId: childId,
        relationType: "subtask",
        ...(replaceParent ? { replaceParent } : {}),
      });

    expect((await parent(a.id, c.id)).status).toBe(200);
    const second = await parent(b.id, c.id);
    expect(second.status).toBe(409);
    expect((await readErrorBody(second)).message).toContain(
      "subtask_second_parent",
    );
    expect(await subtaskLinks()).toEqual([`${a.id}>${c.id}`]);

    m.publish.mockClear();
    const moved = await parent(b.id, c.id, true);
    expect(moved.status).toBe(200);
    expect(await subtaskLinks()).toEqual([`${b.id}>${c.id}`]);
    expect(m.publish.mock.calls.map(([name]) => name)).toEqual([
      "task-relation.deleted",
      "task-relation.created",
    ]);
    expect(m.publish.mock.calls[0][1]).toMatchObject({
      sourceTaskId: a.id,
      targetTaskId: c.id,
      projectId: a.projectId,
    });

    // replaceParent on a card without a parent is a plain link.
    expect((await parent(c.id, a.id, true)).status).toBe(200);
  });

  it("keeps the old parent when the move would close a cycle", async () => {
    const own = await context();
    mockAuthenticatedSession(own.user);
    const a = own.task;
    const c = await addCard(a.projectId, "C");
    const d = await addCard(a.projectId, "D");
    const e = await addCard(a.projectId, "E");
    const link = (sourceTaskId: string, targetTaskId: string) =>
      request("", "POST", {
        sourceTaskId,
        targetTaskId,
        relationType: "subtask",
        replaceParent: true,
      });
    expect((await link(a.id, c.id)).status).toBe(200);
    expect((await link(c.id, d.id)).status).toBe(200);
    expect((await link(d.id, e.id)).status).toBe(200);

    // Moving C under its own grandchild E: refused, and C keeps A.
    const loop = await link(e.id, c.id);
    expect(loop.status).toBe(409);
    expect((await readErrorBody(loop)).message).toContain("subtask_cycle");
    expect((await subtaskLinks()).sort()).toEqual(
      [`${a.id}>${c.id}`, `${c.id}>${d.id}`, `${d.id}>${e.id}`].sort(),
    );
  });

  it("lets only one of two simultaneous parents through", async () => {
    const own = await context();
    mockAuthenticatedSession(own.user);
    const a = own.task;
    const b = await addCard(a.projectId, "B");
    const c = await addCard(a.projectId, "C");
    const responses = await Promise.all(
      [a, b].map((p) =>
        request("", "POST", {
          sourceTaskId: p.id,
          targetTaskId: c.id,
          relationType: "subtask",
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await subtaskLinks()).toHaveLength(1);
  });

  it("an import keeps the parent a card already has", async () => {
    const own = await context();
    const a = own.task;
    const b = await addCard(a.projectId, "B");
    const c = await addCard(a.projectId, "C");
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: a.id,
      targetTaskId: c.id,
      relationType: "subtask",
    });

    const written = await db.transaction((tx) =>
      writeImportRelations(tx, own.workspace.id, [
        { sourceTaskId: b.id, targetTaskId: c.id, relationType: "subtask" },
        { sourceTaskId: b.id, targetTaskId: a.id, relationType: "subtask" },
        { sourceTaskId: b.id, targetTaskId: c.id, relationType: "related" },
      ]),
    );
    expect(written).toBe(2);
    expect((await subtaskLinks()).sort()).toEqual(
      [`${a.id}>${c.id}`, `${b.id}>${a.id}`].sort(),
    );
  });
});
