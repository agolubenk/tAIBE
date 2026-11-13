import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
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
    const [a, b, changed, leased] = await Promise.all(
      ["A", "B", "Changed", "Leased"].map((title) =>
        addTask(forest.project.id, title),
      ),
    );
    if (!a || !b || !changed || !leased) throw new Error("tasks");

    const asked = await askBatch(forest, [a.id, b.id, changed.id, leased.id]);
    expect(asked.status).toBe(200);
    expect(asked.body.targetType).toBe("workspace");
    expect(asked.body.params.taskIds.split(",")).toHaveLength(4);
    expect(asked.body.params.targets).toBe(`${forest.project.id}=done`);

    // After the request: one card moves on, another is taken by a session.
    await db
      .update(schema.taskTable)
      .set({ status: "in-progress" })
      .where(eq(schema.taskTable.id, changed.id));
    expect(
      (await forest.agent("/leases", { taskId: leased.id }, "dev-2")).status,
    ).toBe(200);

    const decided = await forest.owner(`/approvals/${asked.body.id}/decide`, {
      decision: "approved",
    });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("consumed");
    expect(await statusOf(a.id)).toBe("done");
    expect(await statusOf(b.id)).toBe("done");
    expect(await statusOf(changed.id)).toBe("in-progress");
    expect(await statusOf(leased.id)).toBe("to-do");

    const [report] = await journal("approval.batch_report", asked.body.id);
    expect(report?.detail).toMatch(/^закрыто 2 из 4; пропущено 2: /);
    expect(report?.detail).toContain("(изменилась после заявки)");
    expect(report?.detail).toContain("(в аренде у сессии)");
    expect(await journal("approval.skipped", changed.id)).toHaveLength(1);
    expect(await journal("approval.skipped", leased.id)).toHaveLength(1);
    expect(await journal("approval.applied", a.id)).toHaveLength(1);

    // R-6: a second «да» changes nothing.
    const again = await forest.owner(`/approvals/${asked.body.id}/decide`, {
      decision: "approved",
    });
    expect(again.status).toBe(409);
    expect(await journal("approval.applied", a.id)).toHaveLength(1);
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
    expect(
      (
        await askBatch(
          forest,
          Array.from({ length: 251 }, (_, i) => `id-${i}`),
        )
      ).status,
    ).toBe(400);

    // The batch's limit does not raise a grant's: 20 cards at most.
    const label = await forest.agent("/approvals", {
      action: "create_label",
      targetId: forest.workspace.id,
      label: { name: "x", color: "#000000" },
      taskIds: Array.from({ length: 21 }, () => open.id).map(
        (id, i) => `${id}-${i}`,
      ),
      reason: "grant",
    });
    expect(label.status).toBe(400);

    // The clean card alone passes; a second batch on it is refused.
    expect((await askBatch(forest, [open.id])).status).toBe(200);
    const twice = await askBatch(forest, [open.id]);
    expect(twice.status).toBe(400);
    expect(twice.body.message).toContain("approval_pending");
  });
});
