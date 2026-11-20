import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

const history = (taskId: string) => `/cards/${taskId}/history`;
const rollback = (taskId: string, entryId: string) =>
  `${history(taskId)}/${entryId}/rollback`;

async function lease(forest: Forest, taskId: string) {
  const res = await forest.agent("/leases", { taskId }, "dev-1");
  expect(res.status).toBe(200);
  return String(res.body.fencingToken);
}

async function taskRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

async function journal(action: string, targetId: string) {
  return db
    .select()
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.action, action),
        eq(agentJournalTable.targetId, targetId),
      ),
    );
}

async function agentCard(forest: Forest) {
  const created = await forest.agentApi("POST", `/task/${forest.project.id}`, {
    title: "Finding",
    description: "First notes",
    priority: "low",
    status: "to-do",
  });
  expect(created.status).toBe(200);
  return String(created.body.id);
}

async function entries(forest: Forest, taskId: string) {
  const res = await forest.owner(history(taskId));
  expect(res.status).toBe(200);
  return res.body.entries as Array<{
    id: string;
    kind: string;
    revision: number | null;
    changes: Record<string, { from: unknown; to: unknown }>;
    actorId: string | null;
  }>;
}

function ownerTitle(forest: Forest, taskId: string, title: string) {
  return forest.ownerApi("PUT", `/task/title/${taskId}`, { title });
}

describe("API integration: card history and rollback (R-023)", () => {
  beforeEach(resetTestDatabase);

  it("undoes an agent's edit in one action: text and fields match the version before (AC-009)", async () => {
    const forest = await createForest();
    const id = await agentCard(forest);
    const token = await lease(forest, id);
    const before = await taskRow(id);
    const current = await forest.agentApi("GET", `/task/${id}`);

    const edit = await forest.agentApi(
      "PUT",
      `/task/${id}`,
      {
        title: "Finding, rewritten",
        description: "Agent's version",
        status: "in-review",
        priority: current.body.priority,
        projectId: current.body.projectId,
        position: current.body.position ?? 0,
        dueDate: "2026-11-01T10:00:00.000Z",
      },
      // A card goes to review with a link to the PR or commit (card-fill rule).
      {
        "x-t-boards-fence": token,
        "x-t-boards-link": "https://github.com/agolubenk/tAIBE/pull/1",
      },
      "dev-1",
    );
    expect(edit.status).toBe(200);

    // Going to review also triggers card-fill (assignee, start date) in its
    // own, next history row, named after the agent whose move caused it.
    const afterEdit = await entries(forest, id);
    const agentRows = afterEdit.filter((e) =>
      /^key:.+:dev-1$/.test(e.actorId ?? ""),
    );
    const entry = agentRows.find((e) => "status" in e.changes);
    const fill = agentRows.find((e) => "assigneeId" in e.changes);
    expect(entry).toMatchObject({
      kind: "task",
      revision: before?.revision,
      actorId: expect.stringMatching(/^key:.+:dev-1$/),
      changes: {
        title: { from: "Finding", to: "Finding, rewritten" },
        description: { from: "First notes", to: "Agent's version" },
        status: { from: "to-do", to: "in-review" },
        dueDate: { from: null, to: "2026-11-01T10:00:00.000Z" },
      },
    });
    expect(fill).toMatchObject({
      kind: "task",
      revision: (before?.revision ?? 0) + 1,
      actorId: entry?.actorId,
      changes: { assigneeId: { from: null }, startDate: { from: null } },
    });

    const undone = await forest.owner(rollback(id, String(entry?.id)), {});
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ kind: "task", meta: null });

    // One action returns everything the agent's move changed, the autofill
    // included: the card matches the version before in every field (TB-69).
    const after = await taskRow(id);
    expect(after).toMatchObject({
      title: before?.title,
      description: before?.description,
      status: before?.status,
      columnId: before?.columnId,
      priority: before?.priority,
      dueDate: before?.dueDate,
      userId: before?.userId,
      startDate: before?.startDate,
    });
    expect(after?.revision).toBe(undone.body.revision);

    // The autofill row is spent: undoing it again finds the fields changed.
    const again = await forest.owner(rollback(id, String(fill?.id)), {});
    expect(again.status).toBe(409);
    expect(again.body.message).toContain("history_conflict");

    const [latest] = await entries(forest, id);
    expect(latest?.actorId).toMatch(/^session:/);
    expect(await journal("card.rollback", id)).toMatchObject([
      { outcome: "allowed", actorKind: "owner-ui" },
      { outcome: "denied", actorKind: "owner-ui" },
    ]);
  });

  it("an assignee someone set after the autofill survives the rollback of the agent's move", async () => {
    const forest = await createForest();
    const id = await agentCard(forest);
    const token = await lease(forest, id);
    const before = await taskRow(id);
    const current = await forest.agentApi("GET", `/task/${id}`);
    const moved = await forest.agentApi(
      "PUT",
      `/task/${id}`,
      {
        title: current.body.title,
        description: current.body.description,
        status: "in-review",
        priority: current.body.priority,
        projectId: current.body.projectId,
        position: current.body.position ?? 0,
      },
      {
        "x-t-boards-fence": token,
        "x-t-boards-link": "https://github.com/agolubenk/tAIBE/pull/1",
      },
      "dev-1",
    );
    expect(moved.status).toBe(200);
    const filled = await taskRow(id);
    expect(filled?.userId).toBeTruthy();
    expect(filled?.startDate).toBeTruthy();

    // Another member takes the card over after the agent's move (the agent
    // key acts for the owner, so the autofill assigned the owner).
    expect(filled?.userId).toBe(forest.ownerId);
    const [colleague] = await db
      .insert(schema.userTable)
      .values({
        id: "user-colleague-tb69",
        email: "colleague-tb69@example.com",
        emailVerified: true,
        name: "Colleague",
      })
      .returning();
    if (!colleague) throw new Error("no colleague");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: forest.workspace.id,
      userId: colleague.id,
      role: "member",
      joinedAt: new Date(),
    });
    const assigned = await forest.ownerApi("PUT", `/task/assignee/${id}`, {
      userId: colleague.id,
    });
    expect(assigned.status).toBe(200);

    const entry = (await entries(forest, id)).find(
      (e) => /^key:.+:dev-1$/.test(e.actorId ?? "") && "status" in e.changes,
    );
    const undone = await forest.owner(rollback(id, String(entry?.id)), {});
    expect(undone.status).toBe(200);
    expect(await taskRow(id)).toMatchObject({
      status: before?.status,
      startDate: before?.startDate,
      userId: colleague.id,
    });
  });

  it("refuses to drop a later edit of the same field, and undoes in order", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Plan");
    expect((await ownerTitle(forest, task.id, "Plan v2")).status).toBe(200);
    expect((await ownerTitle(forest, task.id, "Plan v3")).status).toBe(200);
    const [third, second] = await entries(forest, task.id);
    expect(second).toMatchObject({ actorId: null });

    const early = await forest.owner(rollback(task.id, String(second?.id)), {});
    expect(early.status).toBe(409);
    expect(early.body.message).toContain("history_conflict");
    expect((await taskRow(task.id))?.title).toBe("Plan v3");

    expect(
      (await forest.owner(rollback(task.id, String(third?.id)), {})).status,
    ).toBe(200);
    expect(
      (await forest.owner(rollback(task.id, String(second?.id)), {})).status,
    ).toBe(200);
    expect((await taskRow(task.id))?.title).toBe("Plan");
  });

  it("refuses a rollback from an agent and journals it", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Plan");
    await ownerTitle(forest, task.id, "Plan v2");
    const [entry] = await entries(forest, task.id);

    const res = await forest.agent(
      rollback(task.id, String(entry?.id)),
      {},
      "dev-1",
    );

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("agent_forbidden");
    expect((await taskRow(task.id))?.title).toBe("Plan v2");
    expect(await journal("card.rollback", task.id)).toMatchObject([
      { outcome: "denied", actorKind: "agent" },
    ]);
  });

  it("undoes an agent's change of the card fields back to the defaults", async () => {
    const forest = await createForest();
    const id = await agentCard(forest);
    const token = await lease(forest, id);
    const put = await forest.agentApi(
      "PUT",
      `/forest/${forest.workspace.id}/cards/${id}/meta`,
      { branch: "fix/x", files: ["a.ts"], costUsd: 0.5 },
      { "x-t-boards-fence": token },
      "dev-1",
    );
    expect(put.status).toBe(200);

    const [entry] = await entries(forest, id);
    expect(entry).toMatchObject({
      kind: "meta",
      revision: null,
      actorId: expect.stringMatching(/^key:.+:dev-1$/),
      changes: {
        branch: { from: null, to: "fix/x" },
        files: { from: [], to: ["a.ts"] },
        costUsd: { from: null, to: 0.5 },
      },
    });

    const undone = await forest.owner(rollback(id, String(entry?.id)), {});
    expect(undone.status).toBe(200);
    expect(undone.body.meta).toMatchObject({
      branch: null,
      files: [],
      costUsd: null,
    });
  });
});
