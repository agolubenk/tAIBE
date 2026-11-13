import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  agentJournalTable,
  ownerApprovalTable,
} from "../../apps/api/src/database/forest-schema";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

async function lease(forest: Forest, taskId: string, session = "dev-1") {
  const res = await forest.agent("/leases", { taskId }, session);
  expect(res.status).toBe(200);
  return String(res.body.fencingToken);
}

async function request(
  forest: Forest,
  action: "close_task" | "reopen_task" | "set_priority",
  targetId: string,
  value: string,
) {
  const requested = await forest.agent("/approvals", {
    action,
    targetId,
    value,
    reason: "agent asks",
    ...(action === "close_task"
      ? { doneRef: "https://github.com/agolubenk/tAIBE/pull/1" }
      : {}),
  });
  expect(requested.status).toBe(200);
  expect(requested.body.params).toEqual(
    action === "set_priority" ? { priority: value } : { status: value },
  );
  return String(requested.body.id);
}

// TB-102: «да» in t-boards applies the request at once (R-12).
async function approve(
  forest: Forest,
  action: "close_task" | "reopen_task" | "set_priority",
  targetId: string,
  value: string,
) {
  const id = await request(forest, action, targetId, value);
  const decided = await forest.owner(`/approvals/${id}/decide`, {
    decision: "approved",
  });
  expect(decided.status).toBe(200);
  expect(decided.body.status).toBe("consumed");
  return id;
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

async function taskRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

describe("API integration: agent rights on kaneo routes", () => {
  beforeEach(resetTestDatabase);

  it("refuses an agent delete and journals it; the owner's UI still deletes (AC-007)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Owner task");

    const denied = await forest.agentApi("DELETE", `/task/${task.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("agent_forbidden");
    expect(await taskRow(task.id)).toBeDefined();
    const [entry] = await journal("task.delete", task.id);
    expect(entry).toMatchObject({
      outcome: "denied",
      actorKind: "agent",
      workspaceId: forest.workspace.id,
    });

    const owner = await forest.ownerApi("DELETE", `/task/${task.id}`);
    expect(owner.status).toBe(200);
  });

  it("refuses deleting a project or the workspace with an agent key", async () => {
    const forest = await createForest();

    const project = await forest.agentApi(
      "DELETE",
      `/project/${forest.project.id}`,
    );
    expect(project.status).toBe(403);
    expect(await journal("project.delete", forest.project.id)).toHaveLength(1);

    const workspace = await forest.agentApi(
      "POST",
      "/auth/organization/delete",
      { organizationId: forest.workspace.id },
    );
    expect(workspace.status).toBe(403);
    expect(workspace.body.message).toContain("agent_forbidden");
  });

  it("keeps the owner's text and lets the agent edit its own card (AC-007)", async () => {
    const forest = await createForest();
    const ownerTask = await addTask(forest.project.id, "Owner task");
    const token = await lease(forest, ownerTask.id);

    const title = await forest.agentApi(
      "PUT",
      `/task/title/${ownerTask.id}`,
      { title: "Agent rewrote it" },
      { "x-t-boards-fence": token },
      "dev-1",
    );
    expect(title.status).toBe(403);
    expect((await taskRow(ownerTask.id))?.title).toBe("Owner task");
    expect(await journal("task.title", ownerTask.id)).toHaveLength(1);

    const created = await forest.agentApi(
      "POST",
      `/task/${forest.project.id}`,
      {
        title: "Finding",
        description: "",
        priority: "low",
        status: "to-do",
      },
    );
    expect(created.status).toBe(200);
    const own = String(created.body.id);
    const ownToken = await lease(forest, own);
    const renamed = await forest.agentApi(
      "PUT",
      `/task/title/${own}`,
      { title: "Finding, clearer" },
      { "x-t-boards-fence": ownToken },
      "dev-1",
    );
    expect(renamed.status).toBe(200);
    expect((await taskRow(own))?.title).toBe("Finding, clearer");
  });

  it("writes only under the session's live lease and token (AC-010)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const status = (headers: Record<string, string>, session?: string) =>
      forest.agentApi(
        "PUT",
        `/task/status/${task.id}`,
        { status: "in-progress" },
        headers,
        session,
      );

    const noLease = await status({}, "dev-1");
    expect(noLease.status).toBe(409);
    expect(noLease.body.message).toContain("lease_missing");

    const token = await lease(forest, task.id, "dev-1");
    const other = await status({ "x-t-boards-fence": token }, "dev-2");
    expect(other.status).toBe(409);
    expect(other.body.message).toContain("lease_conflict");

    const ok = await status({ "x-t-boards-fence": token }, "dev-1");
    expect(ok.status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("in-progress");

    await forest.agent(
      "/leases/release",
      { taskId: task.id, fencingToken: Number(token) },
      "dev-1",
    );
    const stale = await status({ "x-t-boards-fence": token }, "dev-1");
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain("lease_stale");
    expect(
      (await journal("task.status", task.id)).map((row) => row.outcome),
    ).toEqual(["denied", "denied", "denied"]);
  });

  it("closes a card only with the owner's «да» for that status, once (AC-008)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const token = await lease(forest, task.id);
    const close = (status: string, approvalId?: string) =>
      forest.agentApi(
        "PUT",
        `/task/status/${task.id}`,
        { status },
        {
          "x-t-boards-fence": token,
          // A card goes to review with what to review (card fill, 30.10).
          "x-t-boards-link": "https://github.com/agolubenk/t-boards/pull/1",
          ...(approvalId ? { "x-t-boards-approval": approvalId } : {}),
        },
        "dev-1",
      );

    const unapproved = await close("done");
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.message).toContain("approval_required");
    expect(unapproved.body.message).toContain("close_task");

    const approvalId = await approve(forest, "close_task", task.id, "done");
    expect((await taskRow(task.id))?.status).toBe("done");
    expect(await journal("approval.applied", task.id)).toHaveLength(1);

    // R-5: the spent id gives no right for another value or another card.
    const otherStatus = await close("archived", approvalId);
    expect(otherStatus.status).toBe(409);
    expect(otherStatus.body.message).toContain("approval_mismatch");
    const other = await addTask(forest.project.id, "Other");
    const otherToken = await lease(forest, other.id);
    const borrowed = await forest.agentApi(
      "PUT",
      `/task/status/${other.id}`,
      { status: "done" },
      {
        "x-t-boards-fence": otherToken,
        "x-t-boards-approval": approvalId,
      },
      "dev-1",
    );
    expect(borrowed.status).toBe(409);
    expect(borrowed.body.message).toContain("approval_mismatch");
    expect((await taskRow(other.id))?.status).toBe("to-do");

    const again = await close("done", approvalId);
    expect(again.status).toBe(200);
    const [spent] = await db
      .select()
      .from(ownerApprovalTable)
      .where(eq(ownerApprovalTable.id, approvalId));
    expect(spent?.status).toBe("consumed");
    expect(await journal("approval.applied", task.id)).toHaveLength(1);
  });

  // d-tb-reopen, owner 28.10: reopening is approved like closing.
  it("reopens a closed card only with the owner's «да» for that status", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(eq(schema.taskTable.id, task.id));
    const token = await lease(forest, task.id);
    const move = (status: string, approvalId?: string) =>
      forest.agentApi(
        "PUT",
        `/task/status/${task.id}`,
        { status },
        {
          "x-t-boards-fence": token,
          ...(approvalId ? { "x-t-boards-approval": approvalId } : {}),
        },
        "dev-1",
      );

    const unapproved = await move("to-do");
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.message).toContain("reopen_task");

    const stillClosed = await forest.agent("/approvals", {
      action: "reopen_task",
      targetId: task.id,
      value: "archived",
      reason: "agent asks",
    });
    expect(stillClosed.status).toBe(400);

    await approve(forest, "reopen_task", task.id, "to-do");
    expect((await taskRow(task.id))?.status).toBe("to-do");
    expect(await journal("approval.applied", task.id)).toHaveLength(1);

    const openAlready = await forest.agent("/approvals", {
      action: "reopen_task",
      targetId: task.id,
      value: "in-progress",
      reason: "agent asks",
    });
    expect(openAlready.status).toBe(400);
  });

  // TB-82: the guard judges the column the move lands in, not the request.
  it("moves a card between projects only if it stays open, or closed in its stage", async () => {
    const forest = await createForest();
    const project = async (column?: { slug: string; isFinal?: boolean }) => {
      const { project: created } = await createProjectFixture({
        workspaceId: forest.workspace.id,
      });
      if (column?.isFinal === undefined && column) {
        await db
          .delete(schema.columnTable)
          .where(
            and(
              eq(schema.columnTable.projectId, created.id),
              eq(schema.columnTable.slug, column.slug),
            ),
          );
      } else if (column) {
        await db
          .update(schema.columnTable)
          .set({ isFinal: column.isFinal })
          .where(
            and(
              eq(schema.columnTable.projectId, created.id),
              eq(schema.columnTable.slug, column.slug),
            ),
          );
      }
      return created.id;
    };
    const card = async (status: string) => {
      const task = await addTask(forest.project.id, "Task");
      await db
        .update(schema.taskTable)
        .set({ status })
        .where(eq(schema.taskTable.id, task.id));
      return { id: task.id, token: await lease(forest, task.id) };
    };
    const move = (
      task: { id: string; token: string },
      destinationProjectId: string,
      destinationStatus?: string,
    ) =>
      forest.agentApi(
        "PUT",
        `/task/move/${task.id}`,
        { destinationProjectId, destinationStatus },
        { "x-t-boards-fence": task.token },
        "dev-1",
      );

    // No «done» in the new project: the card would land in «new», open.
    const closed = await card("done");
    const reopens = await move(closed, await project({ slug: "done" }));
    expect(reopens.status).toBe(403);
    expect(reopens.body.message).toContain("reopen_task");
    // The same slug, but not final in the new project: a reopen too.
    const sameSlug = await move(
      closed,
      await project({ slug: "done", isFinal: false }),
    );
    expect(sameSlug.status).toBe(403);
    expect(sameSlug.body.message).toContain("reopen_task");
    expect(await taskRow(closed.id)).toMatchObject({
      projectId: forest.project.id,
      status: "done",
    });
    expect(await journal("task.move", closed.id)).toHaveLength(2);

    const open = await card("to-do");
    const closes = await move(open, await project(), "done");
    expect(closes.status).toBe(403);
    expect(closes.body.message).toContain("close_task");
    expect((await taskRow(open.id))?.projectId).toBe(forest.project.id);

    const kept = await move(open, await project({ slug: "to-do" }));
    expect(kept.status).toBe(200);
    expect(await taskRow(open.id)).toMatchObject({ status: "new" });

    const stays = await move(closed, await project());
    expect(stays.status).toBe(200);
    expect(await taskRow(closed.id)).toMatchObject({ status: "done" });

    // Another workspace: not judged (its columns stay hidden), move-task 404.
    const foreign = await createForest();
    const elsewhere = await card("done");
    const hidden = await move(elsewhere, foreign.project.id, "to-do");
    expect(hidden.status).toBe(404);
    expect((await taskRow(elsewhere.id))?.projectId).toBe(forest.project.id);
  });

  // Owner, 29.10: an agent stops at «На ревью»; the owner's stages past it are
  // approved like a close, and so is taking a card back out of them.
  it("moves a card to review freely but into the owner's confirmation only with a «да»", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const token = await lease(forest, task.id);
    const move = (status: string, approvalId?: string) =>
      forest.agentApi(
        "PUT",
        `/task/status/${task.id}`,
        { status },
        {
          "x-t-boards-fence": token,
          "x-t-boards-link": "https://github.com/agolubenk/t-boards/pull/1",
          ...(approvalId ? { "x-t-boards-approval": approvalId } : {}),
        },
        "dev-1",
      );

    expect((await move("in-review")).status).toBe(200);
    const unapproved = await move("confirmation");
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.message).toContain("close_task");

    await approve(forest, "close_task", task.id, "confirmation");
    expect((await taskRow(task.id))?.status).toBe("confirmation");

    const back = await move("in-progress");
    expect(back.status).toBe(403);
    expect(back.body.message).toContain("reopen_task");
  });

  it("changes priority only with a «да»; a pending request gives no right (R-5)", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const token = await lease(forest, task.id);
    const fence = { "x-t-boards-fence": token };

    const unapproved = await forest.agentApi(
      "PUT",
      `/task/priority/${task.id}`,
      { priority: "urgent" },
      fence,
      "dev-1",
    );
    expect(unapproved.status).toBe(403);

    const pendingId = await request(forest, "set_priority", task.id, "urgent");
    const early = await forest.agentApi(
      "PUT",
      `/task/priority/${task.id}`,
      { priority: "urgent" },
      { ...fence, "x-t-boards-approval": pendingId },
      "dev-1",
    );
    expect(early.status).toBe(409);
    expect(early.body.message).toContain("approval_pending");
    expect((await taskRow(task.id))?.priority).not.toBe("urgent");

    const decided = await forest.owner(`/approvals/${pendingId}/decide`, {
      decision: "approved",
    });
    expect(decided.body.status).toBe("consumed");
    expect((await taskRow(task.id))?.priority).toBe("urgent");
  });

  it("refuses the agent's own «да» on a close (AC-027) and closed creates", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const requested = await forest.agent("/approvals", {
      action: "close_task",
      targetId: task.id,
      value: "done",
      reason: "agent asks",
    });
    const self = await forest.agent(`/approvals/${requested.body.id}/decide`, {
      decision: "approved",
    });
    expect(self.status).toBe(403);
    expect(self.body.message).toContain("owner_session_required");

    const openOnly = await forest.agent("/approvals", {
      action: "close_task",
      targetId: task.id,
      value: "in-review",
      reason: "not a closing status",
    });
    expect(openOnly.status).toBe(400);

    const closedCreate = await forest.agentApi(
      "POST",
      `/task/${forest.project.id}`,
      {
        title: "Done already",
        description: "",
        priority: "low",
        status: "done",
      },
    );
    expect(closedCreate.status).toBe(403);
  });

  it("refuses agent bulk and reorder writes, and leaves the owner's UI alone", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");

    const bulk = await forest.agentApi("PATCH", "/task/bulk", {
      taskIds: [task.id],
      operation: "delete",
    });
    expect(bulk.status).toBe(403);
    const reorder = await forest.agentApi("POST", "/task/reorder", {
      projectId: forest.project.id,
      tasks: [],
    });
    expect(reorder.status).toBe(403);

    const owner = await forest.ownerApi("PUT", `/task/status/${task.id}`, {
      status: "done",
    });
    expect(owner.status).toBe(200);
  });

  it("refuses an agent write whose body the guard cannot read as plain JSON", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Owner task");
    const token = await lease(forest, task.id);

    const sneaky = await forest.agentApi(
      "PUT",
      `/task/title/${task.id}`,
      { title: "Agent rewrote it" },
      {
        "content-type": "application/merge-patch+json",
        "x-t-boards-fence": token,
      },
      "dev-1",
    );
    expect(sneaky.status).toBe(403);
    expect(sneaky.body.message).toContain("agent_forbidden");
    expect((await taskRow(task.id))?.title).toBe("Owner task");
    const [entry] = await journal("task.title", task.id);
    expect(entry?.outcome).toBe("denied");
  });

  it("lets a full update through when only the status changes, as MCP update_task sends it", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Owner task");
    const token = await lease(forest, task.id);
    const current = await forest.agentApi("GET", `/task/${task.id}`);
    const full = (patch: Record<string, unknown>) =>
      forest.agentApi(
        "PUT",
        `/task/${task.id}`,
        {
          title: current.body.title,
          description: current.body.description ?? "",
          status: current.body.status,
          priority: current.body.priority,
          projectId: current.body.projectId,
          position: current.body.position ?? 0,
          ...patch,
        },
        {
          "x-t-boards-fence": token,
          "x-t-boards-link": "https://github.com/agolubenk/t-boards/pull/1",
        },
        "dev-1",
      );

    const moved = await full({ status: "in-review" });
    expect(moved.status).toBe(200);
    expect((await taskRow(task.id))?.status).toBe("in-review");

    const rewritten = await full({ description: "Agent's version" });
    expect(rewritten.status).toBe(403);
    expect((await taskRow(task.id))?.description ?? "").toBe(
      current.body.description ?? "",
    );
  });
});
