import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { readErrorBody } from "./helpers/error-body";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// Both workspaces use the same project key, so an unscoped ticket lookup is
// ambiguous and a scoped one must resolve to workspace A alone.
const PROJECT_KEY = "tb";

async function seedTwoWorkspaces() {
  const { user, workspace: workspaceA } = await createWorkspaceMember({
    role: "owner",
    workspaceName: "Product A",
  });
  const [workspaceB] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${randomUUID()}`,
      createdAt: new Date(),
      name: "Product B",
      slug: `workspace-${randomUUID()}`,
    })
    .returning();
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: workspaceB.id,
    userId: user.id,
    role: "owner",
    joinedAt: new Date(),
  });

  const { project: projectA } = await createProjectFixture({
    workspaceId: workspaceA.id,
    slug: PROJECT_KEY,
  });
  const { project: projectB } = await createProjectFixture({
    workspaceId: workspaceB.id,
    slug: PROJECT_KEY,
  });
  for (const project of [projectA, projectB]) {
    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: `Task in ${project.id}`,
      status: "to-do",
      number: 1,
    });
  }

  return { user, workspaceA, workspaceB, projectA, projectB };
}

async function createKey(userId: string, metadata?: Record<string, unknown>) {
  const { key } = await auth.api.createApiKey({
    body: { userId, name: "Workspace scope test", metadata },
  });
  return key;
}

function get(path: string, key: string) {
  const { app } = createApp();
  return app.request(path, { headers: { "x-api-key": key } });
}

describe("API integration: workspace-scoped API keys (AC-011)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("keeps a key for product A out of product B", async () => {
    const { user, workspaceA, workspaceB, projectA, projectB } =
      await seedTwoWorkspaces();
    const key = await createKey(user.id, { workspaceId: workspaceA.id });

    expect(
      (await get(`/api/project?workspaceId=${workspaceA.id}`, key)).status,
    ).toBe(200);
    expect(
      (await get(`/api/project?workspaceId=${workspaceB.id}`, key)).status,
    ).toBe(404);
    expect((await get(`/api/project/${projectA.id}`, key)).status).toBe(200);
    expect((await get(`/api/project/${projectB.id}`, key)).status).toBe(404);

    const workspaces = await get("/api/workspace", key);
    expect(workspaces.status).toBe(200);
    expect(
      ((await workspaces.json()) as { id: string }[]).map(({ id }) => id),
    ).toEqual([workspaceA.id]);
    expect((await get(`/api/workspace/${workspaceA.id}`, key)).status).toBe(
      200,
    );
    expect((await get(`/api/workspace/${workspaceB.id}`, key)).status).toBe(
      404,
    );

    const organizations = await get("/api/auth/organization/list", key);
    expect(organizations.status).toBe(200);
    expect(
      ((await organizations.json()) as { id: string }[]).map(({ id }) => id),
    ).toEqual([workspaceA.id]);

    const ticket = await get(`/api/task/by-ticket-id/TB-1`, key);
    expect(ticket.status).toBe(200);
    expect(((await ticket.json()) as { projectId: string }).projectId).toBe(
      projectA.id,
    );
    expect(
      (
        await get(
          `/api/task/by-ticket-id/TB-1?workspaceId=${workspaceB.id}`,
          key,
        )
      ).status,
    ).toBe(404);

    // The hooks' own key (card 4): its product's switches, nothing of B, and no write.
    expect(
      (await get(`/api/pipeline-settings/workspace/${workspaceA.id}`, key))
        .status,
    ).toBe(200);
    expect(
      (await get(`/api/pipeline-settings/workspace/${workspaceB.id}`, key))
        .status,
    ).toBe(404);
    const { app } = createApp();
    const write = await app.request(
      `/api/pipeline-settings/workspace/${workspaceA.id}`,
      {
        method: "PUT",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ toggles: { swarm: false } }),
      },
    );
    expect(write.status).toBe(403);
  });

  it("refuses routes that span workspaces or widen the key", async () => {
    const { user, workspaceA } = await seedTwoWorkspaces();
    const key = await createKey(user.id, { workspaceId: workspaceA.id });

    const notifications = await get("/api/notification", key);
    expect(notifications.status).toBe(403);
    expect((await readErrorBody(notifications)).code).toBe(
      "API_KEY_WORKSPACE_SCOPE",
    );

    const { app } = createApp();
    const minted = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ name: "Wider key" }),
    });
    expect(minted.status).toBe(403);
    expect((await readErrorBody(minted)).code).toBe("API_KEY_WORKSPACE_SCOPE");
  });

  it("leaves an unscoped key with the user's full reach", async () => {
    const { user, workspaceA, workspaceB } = await seedTwoWorkspaces();
    const key = await createKey(user.id);

    expect(
      (await get(`/api/project?workspaceId=${workspaceB.id}`, key)).status,
    ).toBe(200);
    const workspaces = await get("/api/workspace", key);
    expect(
      ((await workspaces.json()) as { id: string }[])
        .map(({ id }) => id)
        .sort(),
    ).toEqual([workspaceA.id, workspaceB.id].sort());
    expect((await get("/api/notification", key)).status).toBe(200);
    expect((await get(`/api/task/by-ticket-id/TB-1`, key)).status).toBe(409);
  });

  it("lets a key with an unreadable scope reach nothing", async () => {
    const { user, workspaceA } = await seedTwoWorkspaces();
    const key = await createKey(user.id, { workspaceId: workspaceA.id });
    await db
      .update(schema.apikeyTable)
      .set({ metadata: JSON.stringify({ workspaceId: 7 }) })
      .where(
        or(
          eq(schema.apikeyTable.referenceId, user.id),
          eq(schema.apikeyTable.userId, user.id),
        ),
      );

    expect(
      (await get(`/api/project?workspaceId=${workspaceA.id}`, key)).status,
    ).toBe(404);
    const workspaces = await get("/api/workspace", key);
    expect(await workspaces.json()).toEqual([]);
    expect((await get(`/api/task/by-ticket-id/TB-1`, key)).status).toBe(404);
  });
});
