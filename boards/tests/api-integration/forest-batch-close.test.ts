import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

function askBatch(forest: Forest, taskIds: string[], extra = {}) {
  return forest.agent("/approvals", {
    action: "close_task",
    targetId: forest.workspace.id,
    taskIds,
    doneReason: "import",
    reason: "closed in Notion",
    ...extra,
  });
}

function approve(forest: Forest, approvalId: string) {
  return forest.owner(`/approvals/${approvalId}/decide`, {
    decision: "approved",
  });
}

async function addTasks(projectId: string, count: number) {
  return db
    .insert(schema.taskTable)
    .values(
      Array.from({ length: count }, (_, i) => ({
        projectId,
        title: `Card ${i}`,
        status: "to-do",
        number: i + 1,
      })),
    )
    .returning({ id: schema.taskTable.id });
}

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: schema.taskTable.status })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row?.status;
}

async function journal(action: string, targetId: string) {
  return db
    .select({ detail: agentJournalTable.detail })
    .from(agentJournalTable)
    .where(
      and(
        eq(agentJournalTable.action, action),
        eq(agentJournalTable.targetId, targetId),
      ),
    );
}

// TB-108, owner's «Пакет А» (13.11): one «да» closes up to 250 cards, each to
// its project's final column; a card the server must not close is skipped
// and named in the report.
describe("API integration: batch close_task (TB-108)", () => {
  beforeEach(resetTestDatabase);

  it("closes the cards with one «да» and reports the skipped ones", async () => {
    const forest = await createForest();
    const [a, b, changed, leased, moved] = await Promise.all(
      ["A", "B", "Changed", "Leased", "Moved"].map((title) =>
        addTask(forest.project.id, title),
      ),
    );
    if (!a || !b || !changed || !leased || !moved) throw new Error("tasks");

    const asked = await askBatch(forest, [
      a.id,
      b.id,
      changed.id,
      leased.id,
      moved.id,
    ]);
    expect(asked.status).toBe(200);
    expect(asked.body.targetType).toBe("workspace");
    expect(asked.body.params.taskIds.split(",")).toHaveLength(5);
    expect(asked.body.params.targets).toBe(`${forest.project.id}=done`);

    // After the request: one card moves on, one is taken by a session, one
    // goes to another project that has the same «to-do» column.
    await db
      .update(schema.taskTable)
      .set({ status: "in-progress" })
      .where(eq(schema.taskTable.id, changed.id));
    expect(
      (await forest.agent("/leases", { taskId: leased.id }, "dev-2")).status,
    ).toBe(200);
    const { project: other } = await createProjectFixture({
      workspaceId: forest.workspace.id,
    });
    await db
      .update(schema.taskTable)
      .set({ projectId: other.id })
      .where(eq(schema.taskTable.id, moved.id));

    const decided = await approve(forest, asked.body.id);
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("consumed");
    expect(await statusOf(a.id)).toBe("done");
    expect(await statusOf(b.id)).toBe("done");
    expect(await statusOf(changed.id)).toBe("in-progress");
    expect(await statusOf(leased.id)).toBe("to-do");
    expect(await statusOf(moved.id)).toBe("to-do");

    const [report] = await journal("approval.batch_report", asked.body.id);
    expect(report?.detail).toMatch(/^закрыто 2 из 5; пропущено 3: /);
    expect(report?.detail).toContain("(изменилась после заявки)");
    expect(report?.detail).toContain("(в аренде у сессии)");
    expect(report?.detail).toContain("(перенесена в другой проект)");
    expect(await journal("approval.skipped", changed.id)).toHaveLength(1);
    expect(await journal("approval.skipped", leased.id)).toHaveLength(1);
    expect(await journal("approval.skipped", moved.id)).toHaveLength(1);
    expect(await journal("approval.applied", a.id)).toHaveLength(1);

    // R-6: a second «да» changes nothing.
    const again = await approve(forest, asked.body.id);
    expect(again.status).toBe(409);
    expect(await journal("approval.applied", a.id)).toHaveLength(1);
  });

  // Control lens on #160: a card another write holds is skipped after the
  // lock wait, and the other cards still close.
  it("skips a card another transaction holds, after the lock wait", async () => {
    const forest = await createForest();
    const free = await addTask(forest.project.id, "Free");
    const busy = await addTask(forest.project.id, "Busy");
    if (!free || !busy) throw new Error("tasks");
    const asked = await askBatch(forest, [free.id, busy.id]);
    expect(asked.status).toBe(200);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from task where id = ${busy.id} for update`,
      );
      lockTaken();
      await held;
    });
    await taken;
    const started = Date.now();
    const decided = await approve(forest, asked.body.id);
    const waited = Date.now() - started;
    release();
    await holder;

    expect(decided.status).toBe(200);
    expect(waited).toBeLessThan(8000);
    expect(await statusOf(free.id)).toBe("done");
    expect(await statusOf(busy.id)).toBe("to-do");
    const [report] = await journal("approval.batch_report", asked.body.id);
    expect(report?.detail).toContain("(занята другой записью)");
  });

  it("closes 250 cards with one «да»", async () => {
    const forest = await createForest();
    const cards = await addTasks(forest.project.id, 250);
    const asked = await askBatch(
      forest,
      cards.map((card) => card.id),
    );
    expect(asked.status).toBe(200);

    const started = Date.now();
    const decided = await approve(forest, asked.body.id);
    const took = Date.now() - started;
    expect(decided.status).toBe(200);
    const [report] = await journal("approval.batch_report", asked.body.id);
    expect(report?.detail).toBe("закрыто 250 из 250.");
    const open = await db
      .select({ id: schema.taskTable.id })
      .from(schema.taskTable)
      .where(
        and(
          eq(schema.taskTable.projectId, forest.project.id),
          eq(schema.taskTable.status, "to-do"),
        ),
      );
    expect(open).toHaveLength(0);
    // Measured for the resources lens; the bound is loose on purpose.
    console.info(`TB-108: 250 cards closed in ${took} ms`);
    expect(took).toBeLessThan(30_000);
  });

  it("refuses cards that cannot be in a batch, and names them", async () => {
    const forest = await createForest();
    const open = await addTask(forest.project.id, "Open");
    const idea = await addTask(forest.project.id, "Idea");
    const closed = await addTask(forest.project.id, "Closed");
    const asked = await addTask(forest.project.id, "Asked");
    if (!open || !idea || !closed || !asked) throw new Error("tasks");
    await db.insert(schema.cardMetaTable).values({
      taskId: idea.id,
      workspaceId: forest.workspace.id,
      halfBaked: true,
      updatedBy: "test",
    });
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, closed.id));
    const single = await forest.agent("/approvals", {
      action: "close_task",
      targetId: asked.id,
      value: "done",
      reason: "single",
      doneReason: "obsolete",
    });
    expect(single.status).toBe(200);

    const refused = await askBatch(forest, [
      open.id,
      idea.id,
      closed.id,
      asked.id,
      "no-such-card",
    ]);
    expect(refused.status).toBe(400);
    for (const reason of [
      "half_baked",
      "already_closed",
      "approval_pending",
      "not_found",
    ]) {
      expect(refused.body.message).toContain(reason);
    }

    expect((await askBatch(forest, [open.id], { value: "done" })).status).toBe(
      400,
    );
    expect(
      (await askBatch(forest, [open.id], { targetId: open.id })).status,
    ).toBe(400);

    // The clean card alone passes; a second batch on it is refused.
    expect((await askBatch(forest, [open.id])).status).toBe(200);
    const twice = await askBatch(forest, [open.id]);
    expect(twice.status).toBe(400);
    expect(twice.body.message).toContain("approval_pending");
  });

  // Control lens on #160: the limits are checked on real cards, so the 400
  // comes from the limit and not from «not_found».
  it("takes 250 cards in a batch and 20 in a grant, not one more", async () => {
    const forest = await createForest();
    const cards = (await addTasks(forest.project.id, 251)).map(
      (card) => card.id,
    );

    const tooMany = await askBatch(forest, cards);
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.body)).toContain("250");
    expect(JSON.stringify(tooMany.body)).not.toContain("not_found");

    const grant = (taskIds: string[]) =>
      forest.agent("/approvals", {
        action: "create_label",
        targetId: forest.workspace.id,
        label: { name: "x", color: "#000000" },
        taskIds,
        reason: "grant",
      });
    const grant21 = await grant(cards.slice(0, 21));
    expect(grant21.status).toBe(400);
    expect(grant21.body.message).toBe(
      "taskIds: a grant names at most 20 cards",
    );
    expect((await grant(cards.slice(0, 20))).status).toBe(200);

    expect((await askBatch(forest, cards.slice(1))).status).toBe(200);
  });
});
