import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

const path = (forest: Forest) =>
  `/pipeline-settings/workspace/${forest.workspace.id}`;

async function addMember(forest: Forest, role = "member") {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `member-${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Member",
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: forest.workspace.id,
    userId: user.id,
    role,
    joinedAt: new Date(),
  });
  return user;
}

async function asUser(
  forest: Forest,
  user: typeof schema.userTable.$inferSelect,
  method: string,
  body?: unknown,
) {
  mockAuthenticatedSession(user);
  // ownerApi re-mocks the session; call the app the same way with this user.
  const { createApp } = await import("../../apps/api/src/index");
  const { app } = createApp();
  const res = await app.request(`/api${path(forest)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("pipeline settings per workspace (product)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("starts with every automated part on except the paid judge and the auto-merge", async () => {
    const forest = await createForest();
    const res = await forest.ownerApi("GET", path(forest));
    expect(res.status).toBe(200);
    expect(res.body.automation).toBe(true);
    const off = Object.entries(res.body.toggles)
      .filter(([, on]) => !on)
      .map(([name]) => name);
    expect(off).toEqual(["abJudgeClaude", "evolveAutoMerge"]);
    expect(res.body.toggles).toHaveProperty("cardAutofill", true);
    expect(res.body.updatedAt).toBeNull();
  });

  it("an owner switches one part off; the others keep their values", async () => {
    const forest = await createForest();
    const put = await forest.ownerApi("PUT", path(forest), {
      toggles: { swarm: false },
    });
    expect(put.status).toBe(200);
    expect(put.body.toggles.swarm).toBe(false);
    expect(put.body.toggles.councilReview).toBe(true);
    expect(put.body.updatedBy).toBe(forest.ownerId);

    const off = await forest.ownerApi("PUT", path(forest), {
      automation: false,
    });
    expect(off.body.automation).toBe(false);
    expect(off.body.toggles.swarm).toBe(false); // master switch keeps the values

    const read = await forest.agentApi("GET", path(forest));
    expect(read.status).toBe(200); // tools read it with the workspace's key
    expect(read.body.automation).toBe(false);
  });

  it("agents, API keys and plain members cannot change it", async () => {
    const forest = await createForest();
    const byKey = await forest.agentApi("PUT", path(forest), {
      toggles: { swarm: false },
    });
    expect(byKey.status).toBe(403);

    const member = await addMember(forest);
    const memberRead = await asUser(forest, member, "GET");
    expect(memberRead.status).toBe(200);
    const memberWrite = await asUser(forest, member, "PUT", {
      toggles: { swarm: false },
    });
    expect(memberWrite.status).toBe(403);

    const after = await forest.ownerApi("GET", path(forest));
    expect(after.body.toggles.swarm).toBe(true);
  });

  it("a viewer reads but cannot change", async () => {
    const forest = await createForest();
    const viewer = await addMember(forest, "viewer");
    expect((await asUser(forest, viewer, "GET")).status).toBe(200);
    const write = await asUser(forest, viewer, "PUT", { automation: false });
    expect(write.status).toBe(403);
  });

  it("two saves at once both keep their change", async () => {
    const forest = await createForest();
    await Promise.all([
      forest.ownerApi("PUT", path(forest), { toggles: { swarm: false } }),
      forest.ownerApi("PUT", path(forest), { toggles: { abJudge: false } }),
    ]);
    const after = await forest.ownerApi("GET", path(forest));
    expect(after.body.toggles.swarm).toBe(false);
    expect(after.body.toggles.abJudge).toBe(false);
  });

  it("rejects an unknown part instead of storing it", async () => {
    const forest = await createForest();
    const res = await forest.ownerApi("PUT", path(forest), {
      toggles: { selfDestruct: true },
    });
    expect(res.status).toBe(400);
  });

  it("cardAutofill off: an agent's move fills no fields, the comment still goes out", async () => {
    const forest = await createForest();
    await forest.ownerApi("PUT", path(forest), {
      toggles: { cardAutofill: false },
    });
    const task = await addTask(forest.project.id, "Task");
    const issued = await forest.agentApi("POST", "/agent-identity/session", {
      harness: "claude-code",
      session: "pp",
    });
    const key = String(issued.body.key);
    const lease = await forest.agentApi(
      "POST",
      `/forest/${forest.workspace.id}/leases`,
      { taskId: task.id },
      { "x-api-key": key },
    );
    const moved = await forest.agentApi(
      "PUT",
      `/task/status/${task.id}`,
      { status: "in-progress" },
      { "x-api-key": key, "x-t-boards-fence": String(lease.body.fencingToken) },
    );
    expect(moved.status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task.id));
    expect(row?.userId).toBeNull();
    expect(row?.startDate).toBeNull();
    const comments = await db
      .select({ id: schema.activityTable.id })
      .from(schema.activityTable)
      .where(eq(schema.activityTable.taskId, task.id));
    expect(comments.length).toBeGreaterThan(0);
  });
});
