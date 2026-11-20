import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

async function request(
  forest: Forest,
  action: "close_task" | "reopen_task",
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
  return String(requested.body.id);
}

async function setColumn(
  projectId: string,
  slug: string,
  change: { slug?: string; isFinal?: boolean },
) {
  const changed = await db
    .update(schema.columnTable)
    .set(change)
    .where(
      and(
        eq(schema.columnTable.projectId, projectId),
        eq(schema.columnTable.slug, slug),
      ),
    )
    .returning({ id: schema.columnTable.id });
  expect(changed).toHaveLength(1);
}

async function setStatus(taskId: string, status: string) {
  await db
    .update(schema.taskTable)
    .set({ status })
    .where(eq(schema.taskTable.id, taskId));
}

async function status(taskId: string) {
  const [row] = await db
    .select({ status: schema.taskTable.status })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId));
  return row?.status;
}

describe("API integration: a «да» for a status the project no longer has (TB-90)", () => {
  beforeEach(resetTestDatabase);

  it("fails the close with the approved slug and the statuses to ask for", async () => {
    const forest = await createForest();
    const task = await addTask(forest.project.id, "Task");
    const id = await request(forest, "close_task", task.id, "done");
    // The column was renamed between the request and the owner's answer.
    await setColumn(forest.project.id, "done", { slug: "finished" });

    const decided = await forest.owner(`/approvals/${id}/decide`, {
      decision: "approved",
    });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("failed");
    expect(decided.body.failReason).toMatch(
      /^status_gone: «done» is not a status of the card's project now; ask the owner again for one of: .*finished/,
    );
    expect(decided.body.failReason).not.toContain("to-do");
    expect(await status(task.id)).toBe("to-do");
  });

  it("fails a close whose column stopped closing, and a reopen into a column that closes now", async () => {
    const forest = await createForest();
    const toClose = await addTask(forest.project.id, "To close");
    const closeId = await request(forest, "close_task", toClose.id, "done");
    const toReopen = await addTask(forest.project.id, "To reopen");
    await setStatus(toReopen.id, "archived");
    const reopenId = await request(forest, "reopen_task", toReopen.id, "to-do");
    await setColumn(forest.project.id, "done", { isFinal: false });
    await setColumn(forest.project.id, "to-do", { isFinal: true });

    const close = await forest.owner(`/approvals/${closeId}/decide`, {
      decision: "approved",
    });
    expect(close.body.status).toBe("failed");
    expect(close.body.failReason).toMatch(
      /^status_not_closing: «done» does not close the card now; ask the owner again for one of: /,
    );
    expect(await status(toClose.id)).toBe("to-do");

    const reopen = await forest.owner(`/approvals/${reopenId}/decide`, {
      decision: "approved",
    });
    expect(reopen.body.status).toBe("failed");
    expect(reopen.body.failReason).toMatch(
      /^status_closes: «to-do» closes the card now; ask the owner again for one of: /,
    );
    expect(await status(toReopen.id)).toBe("archived");
  });
});
