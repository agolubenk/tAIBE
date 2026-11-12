import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { ownerApprovalTable } from "../../apps/api/src/database/forest-schema";
import { approvalParamsHash } from "../../apps/api/src/forest/approval/approval-params";
import {
  planStuck,
  revertRun,
  runStuck,
} from "../../apps/api/src/forest/approval/migrate-stuck";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

// A request decided before TB-102: «approved», never spent.
async function legacy(
  forest: Forest,
  action: "close_task" | "set_priority" | "fell_tree",
  targetId: string,
  value: string,
) {
  const params =
    action === "set_priority" ? { priority: value } : { status: value };
  const [row] = await db
    .insert(ownerApprovalTable)
    .values({
      workspaceId: forest.workspace.id,
      action,
      targetType: "task",
      targetId,
      paramsHash: approvalParamsHash(action, targetId, [value]),
      params,
      reason: "old",
      requestedByKind: "agent",
      requestedById: "agent:x",
      requestedByName: "x",
      status: "approved",
      decidedVia: "ui",
      decidedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1000),
    })
    .returning();
  return row?.id as string;
}

async function task(id: string) {
  const [row] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

describe("API integration: R-11 stuck approvals (TB-102 AC-11)", () => {
  beforeEach(resetTestDatabase);

  it("plans, applies once, reruns as a no-op and reverts only untouched cards", async () => {
    const forest = await createForest();
    const toClose = await addTask(forest.project.id, "Close me");
    const toBump = await addTask(forest.project.id, "Bump me");
    const done = await addTask(forest.project.id, "Already done");
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, done?.id as string));
    const tree = await addTask(forest.project.id, "Tree");
    const toLog = await addTask(forest.project.id, "To «Брёвна»");
    const ids = {
      log: await legacy(forest, "close_task", toLog?.id as string, "closed"),
      close: await legacy(forest, "close_task", toClose?.id as string, "done"),
      bump: await legacy(
        forest,
        "set_priority",
        toBump?.id as string,
        "urgent",
      ),
      already: await legacy(forest, "close_task", done?.id as string, "done"),
      fell: await legacy(
        forest,
        "fell_tree",
        tree?.id as string,
        tree?.id as string,
      ),
    };

    const plans = await planStuck();
    const byId = Object.fromEntries(plans.map((p) => [p.approvalId, p]));
    expect(byId[ids.close]).toMatchObject({ outcome: "apply" });
    expect(byId[ids.bump]).toMatchObject({ outcome: "apply" });
    expect(byId[ids.already]).toMatchObject({
      outcome: "consumed",
      reason: "already_applied",
    });
    expect(byId[ids.fell]).toMatchObject({
      outcome: "expired",
      reason: "fell_needs_new_yes",
    });

    expect(await runStuck(plans, "run1")).toEqual([]);
    expect((await task(toClose?.id as string))?.status).toBe("done");
    expect((await task(toBump?.id as string))?.priority).toBe("urgent");
    // R-8: two steps, to-do → done → closed.
    expect((await task(toLog?.id as string))?.status).toBe("closed");
    expect(await planStuck()).toHaveLength(0);
    await runStuck(await planStuck(), "run2");

    // A hand edit after the migration keeps that card out of the revert.
    await db
      .update(schema.taskTable)
      .set({ priority: "low" })
      .where(eq(schema.taskTable.id, toBump?.id as string));
    const report = await revertRun("run1");
    expect(report.some((line) => line.startsWith("reverted"))).toBe(true);
    expect(report.some((line) => line.startsWith("skip"))).toBe(true);
    expect((await task(toClose?.id as string))?.status).toBe("to-do");
    expect((await task(toBump?.id as string))?.priority).toBe("low");
    // Both steps of the two-step path go back (r1 #3).
    expect((await task(toLog?.id as string))?.status).toBe("to-do");
    const [log] = await db
      .select()
      .from(ownerApprovalTable)
      .where(eq(ownerApprovalTable.id, ids.log));
    expect(log).toMatchObject({
      status: "failed",
      failReason: "reverted:run1",
    });
  });
});
