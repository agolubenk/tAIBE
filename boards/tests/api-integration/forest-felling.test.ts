import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  agentJournalTable,
  seedTable,
  taskLeaseTable,
  timberLogTable,
  treeOriginTable,
} from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

async function plantTree(projectId: string, title: string) {
  const root = await addTask(projectId, title);
  const child = await addTask(projectId, `${title} / child`);
  await relate(root.id, child.id);
  return { root, child };
}

// Brevna gate (owner, 31.10): a tree is felled only when every card sits in a
// final column. Tests that fell trees finish them first.
async function finish(...taskIds: string[]) {
  await db
    .update(schema.taskTable)
    .set({ status: "done" })
    .where(inArray(schema.taskTable.id, taskIds));
}

describe("API integration: forest felling", () => {
  beforeEach(resetTestDatabase);

  it("refuses an agent's own «да» and journals the attempt", async () => {
    const forest = await createForest();
    const { root } = await plantTree(forest.project.id, "Tree");

    const unapproved = await forest.agent("/fell", {
      kind: "tree",
      rootId: root.id,
      reason: "done",
    });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.message).toContain("approval_required");

    const approval = await forest.agent("/approvals", {
      action: "fell_tree",
      targetId: root.id,
      reason: "done",
    });
    expect(approval.status).toBe(200);
    expect(approval.body.status).toBe("pending");
    expect(approval.body).not.toHaveProperty("paramsHash");

    const selfApproval = await forest.agent(
      `/approvals/${approval.body.id}/decide`,
      { decision: "approved" },
    );
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.message).toContain("owner_session_required");

    const denied = await db
      .select()
      .from(agentJournalTable)
      .where(
        and(
          eq(agentJournalTable.action, "approval.decide"),
          eq(agentJournalTable.outcome, "denied"),
        ),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.actorKind).toBe("agent");
  });

  // TB-102: the server fells on the owner's «да» itself (R-12); an agent
  // call with the spent approvalId changes nothing.
  it("fells an approved tree into a log with seeds and answers 410 afterwards", async () => {
    const forest = await createForest();
    const { root, child } = await plantTree(forest.project.id, "Tree");
    const neighbour = await addTask(forest.project.id, "Neighbour");
    await relate(child.id, neighbour.id, "blocks");

    const early = await forest.owner("/fell", {
      kind: "tree",
      rootId: root.id,
      reason: "done",
    });
    expect(early.status).toBe(409);
    expect(early.body.message).toContain("not_ready");
    await finish(root.id, child.id);

    const approval = await forest.agent("/approvals", {
      action: "fell_tree",
      targetId: root.id,
      reason: "done",
    });
    const decided = await forest.owner(
      `/approvals/${approval.body.id}/decide`,
      { decision: "approved" },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("consumed");

    const [logRow] = await db
      .select()
      .from(timberLogTable)
      .where(eq(timberLogTable.workspaceId, forest.workspace.id));
    expect(logRow).toBeDefined();
    const felled = { body: { logIds: [String(logRow?.id)] } };

    const reused = await forest.agent("/fell", {
      kind: "tree",
      rootId: neighbour.id,
      approvalId: approval.body.id,
      reason: "done",
    });
    expect(reused.status).toBe(403);

    // Felled cards stay on the board in «Брёвна» (the closed column) and stay
    // readable; nothing is leased or written on them — new work grows from
    // seeds (owner, 01.11).
    const remaining = await db
      .select({ id: schema.taskTable.id, status: schema.taskTable.status })
      .from(schema.taskTable)
      .where(inArray(schema.taskTable.id, [root.id, child.id, neighbour.id]));
    expect(Object.fromEntries(remaining.map((r) => [r.id, r.status]))).toEqual({
      [root.id]: "closed",
      [child.id]: "closed",
      [neighbour.id]: "to-do",
    });
    const readable = await forest.ownerApi("GET", `/task/${child.id}`);
    expect(readable.status).toBe(200);

    const gone = await forest.agent("/leases", { taskId: child.id });
    expect(gone.status).toBe(410);
    expect(gone.body.message).toContain("grow new work from its seeds");

    const log = await forest.agent(`/logs/${felled.body.logIds[0]}`);
    expect(log.status).toBe(200);
    expect(log.body.felledTaskIds).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
    expect(log.body).not.toHaveProperty("searchText");
    const seeds = await db
      .select()
      .from(seedTable)
      .where(eq(seedTable.logId, felled.body.logIds[0]));
    expect(seeds.length).toBeGreaterThan(0);
  });

  it("lets the owner fell directly but not through a live lease or from a branch", async () => {
    const forest = await createForest();
    const { root, child } = await plantTree(forest.project.id, "Tree");
    await finish(root.id, child.id);

    const branch = await forest.owner("/fell", {
      kind: "tree",
      rootId: child.id,
      reason: "done",
    });
    expect(branch.status).toBe(400);
    expect(branch.body.message).toContain("not_a_tree");

    await forest.agent("/leases", { taskId: child.id }, "writer");
    const leased = await forest.owner("/fell", {
      kind: "tree",
      rootId: root.id,
      reason: "done",
    });
    expect(leased.status).toBe(409);
    expect(leased.body.message).toContain("lease_conflict");

    await db
      .update(taskLeaseTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskLeaseTable.taskId, child.id));
    const felled = await forest.owner("/fell", {
      kind: "tree",
      rootId: root.id,
      reason: "done",
    });
    expect(felled.status).toBe(200);
    expect(felled.body.taskCount).toBe(2);
  });

  it("detects a sector, fells it and grows a project from its seeds", async () => {
    const forest = await createForest();
    const a = await plantTree(forest.project.id, "Alpha");
    const b = await plantTree(forest.project.id, "Beta");
    await relate(a.child.id, b.child.id, "related");
    await finish(a.root.id, a.child.id, b.root.id, b.child.id);

    const detected = await forest.agent("/sectors/detect", {});
    expect(detected.status).toBe(200);
    expect(detected.body).toHaveLength(1);
    const sector = detected.body[0];
    expect(sector.treeIds.sort()).toEqual([a.root.id, b.root.id].sort());

    const again = await forest.agent("/sectors/detect", {});
    expect(again.body[0].id).toBe(sector.id);
    expect(again.body[0].created).toBe(false);

    const felled = await forest.owner("/fell", {
      kind: "sector",
      sectorId: sector.id,
      reason: "release shipped",
    });
    expect(felled.status).toBe(200);
    expect(felled.body.logIds).toHaveLength(2);
    expect(felled.body.taskCount).toBe(4);

    const active = await forest.agent("/sectors");
    expect(active.body).toHaveLength(0);

    const page = await forest.agent("/logs?take=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await forest.agent(
      `/logs?take=1&cursor=${page.body.nextCursor}`,
    );
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect(next.body.nextCursor).toBeNull();

    const seeds = await db
      .select({ id: seedTable.id })
      .from(seedTable)
      .where(inArray(seedTable.logId, felled.body.logIds));
    expect(seeds.length).toBeGreaterThan(0);

    const grown = await forest.owner("/grow", {
      seedIds: seeds.map((seed) => seed.id),
      name: "Next release",
      slug: "next",
    });
    expect(grown.status).toBe(200);
    expect(grown.body.taskIds).toHaveLength(seeds.length);
    const origins = await db
      .select()
      .from(treeOriginTable)
      .where(inArray(treeOriginTable.taskId, grown.body.taskIds));
    expect(origins).toHaveLength(seeds.length);

    const logs = await db
      .select({ id: timberLogTable.id })
      .from(timberLogTable)
      .where(eq(timberLogTable.workspaceId, forest.workspace.id));
    expect(logs).toHaveLength(2);
  });
});
