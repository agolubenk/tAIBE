import { randomUUID } from "node:crypto";
import {
  AGENT_ROLE_NAME,
  agent,
  defaultRolePayloads,
  type WorkspaceCapability,
  workspaceCapabilities,
} from "../../apps/api/node_modules/@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import addWorkspaceMemberAsAdmin from "../../apps/api/src/admin/controllers/add-workspace-member";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { realignAgentRoles } from "../../apps/api/src/agent-identity/realign-agent-roles";
import { seedDefaultWorkspaceRoles } from "../../apps/api/src/utils/seed-default-workspace-roles";
import { createApp } from "../../apps/api/src/index";
import { handleMemberRemoved } from "../../apps/api/src/workspace-members/handle-member-removed";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { addWorkspaceMember } from "./helpers/project-access/add-workspace-member";

type Issued = {
  agent: { id: string; name: string; harness: string; session: string };
  key: string;
  keyId: string;
  expiresAt: string | null;
};

async function call(
  method: string,
  path: string,
  key: string | null,
  body?: unknown,
) {
  const { app } = createApp();
  const response = await app.request(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ownerKey(userId: string, metadata?: Record<string, unknown>) {
  const { key } = await auth.api.createApiKey({
    body: { userId, name: "Owner key", metadata },
  });
  return key;
}

async function issue(key: string | null, session = "successor bb") {
  return call("POST", "/agent-identity/session", key, {
    harness: "claude-code",
    session,
  });
}

async function memberships(userId: string) {
  return db
    .select({
      workspaceId: schema.workspaceUserTable.workspaceId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, userId));
}

async function addWorkspace(userId: string, role: string) {
  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${randomUUID()}`,
      createdAt: new Date(),
      name: "Second product",
      slug: `workspace-${randomUUID()}`,
    })
    .returning();
  if (!workspace) throw new Error("workspace not created");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: workspace.id,
    userId,
    role,
    joinedAt: new Date(),
  });
  return workspace;
}

describe("API integration: agents under their own name (R-010)", () => {
  beforeEach(resetTestDatabase);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues a session its own agent that works under its name", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);

    const first = await issue(key);
    expect(first.status).toBe(200);
    const issued = first.body as Issued;
    expect(issued.agent).toMatchObject({
      name: "successor bb · Claude Code",
      harness: "claude-code",
      session: "successor bb",
    });
    expect(issued.agent.id).not.toBe(user.id);
    expect(issued.key).toBeTruthy();

    // The same session gets the same agent; another session another one.
    const again = (await issue(key)).body as Issued;
    expect(again.agent.id).toBe(issued.agent.id);
    const other = (await issue(key, "d9")).body as Issued;
    expect(other.agent.id).not.toBe(issued.agent.id);

    // An owner's agent holds the narrow agent role, never the owner's.
    expect(await memberships(issued.agent.id)).toEqual([
      { workspaceId: workspace.id, role: "agent" },
    ]);

    const put = await call(
      "PUT",
      `/forest/${workspace.id}/work-state`,
      issued.key,
      { step: "Пишу тест" },
    );
    expect(put.status).toBe(200);
    const list = await call(
      "GET",
      `/forest/${workspace.id}/work-state`,
      issued.key,
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        actorKind: "agent",
        actorName: "successor bb · Claude Code",
        step: "Пишу тест",
      }),
    ]);

    const session = await call("GET", "/auth/get-session", issued.key);
    expect(session.status).toBe(200);
  });

  it("refuses keys to agents, one-workspace keys and bad labels", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body as Issued;

    const byAgent = await issue(issued.key, "child");
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.message).toContain("agent_forbidden");

    const scoped = await ownerKey(user.id, { workspaceId: workspace.id });
    // The scope guard refuses it before the issuer check does.
    expect((await issue(scoped)).status).toBe(403);

    // The middle dot would let a session pose as another harness.
    const forged = await issue(await ownerKey(user.id), "x · Codex");
    expect(forged.status).toBe(400);
    const badHarness = await call(
      "POST",
      "/agent-identity/session",
      await ownerKey(user.id),
      { harness: "Claude Code" },
    );
    expect(badHarness.status).toBe(400);
  });

  it("keeps an agent off Better Auth beyond reading itself", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body as Issued;

    const create = await call("POST", "/auth/api-key/create", issued.key, {
      name: "escape",
    });
    expect(create.status).toBe(403);
    expect(create.body.message).toContain("agent_forbidden");
    const rename = await call("POST", "/auth/update-user", issued.key, {
      name: "Owner",
    });
    expect(rename.status).toBe(403);

    const keys = await db
      .select({ id: schema.apikeyTable.id })
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, issued.agent.id));
    expect(keys).toHaveLength(1);
  });

  it("disabling revokes the agent's keys and refuses new ones", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const issued = (await issue(key)).body as Issued;

    const off = await call("PATCH", `/agent-identity/${issued.agent.id}`, key, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      id: issued.agent.id,
      enabled: false,
      archived: false,
      revokedKeys: 1,
    });
    const refused = await call(
      "GET",
      `/forest/${workspace.id}/work-state`,
      issued.key,
    );
    expect(refused.status).toBe(401);
    const reissue = await issue(key);
    expect(reissue.status).toBe(403);
    expect(reissue.body.message).toContain("agent_forbidden");

    // Someone else's agent is not found, not toggled.
    const { user: stranger } = await createWorkspaceMember({ role: "owner" });
    const foreign = await call(
      "PATCH",
      `/agent-identity/${issued.agent.id}`,
      await ownerKey(stranger.id),
      { enabled: true },
    );
    expect(foreign.status).toBe(404);

    // Enabling moves it to the archive (TB-74); its session brings it back.
    const on = await call("PATCH", `/agent-identity/${issued.agent.id}`, key, {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, archived: true });
    const back = await issue(key);
    expect(back.status).toBe(200);
    expect((back.body as Issued).agent.id).toBe(issued.agent.id);
  });

  it("follows the owner's memberships and prunes old keys", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const second = await addWorkspace(user.id, "member");
    const key = await ownerKey(user.id);
    const issued = (await issue(key)).body as Issued;

    expect(
      (await memberships(issued.agent.id)).sort((a, b) =>
        a.workspaceId.localeCompare(b.workspaceId),
      ),
    ).toEqual(
      [
        { workspaceId: workspace.id, role: "agent" },
        { workspaceId: second.id, role: "agent" },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    );

    // The owner is removed from the second product: the agent goes too.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, second.id),
          eq(schema.workspaceUserTable.userId, user.id),
        ),
      );
    await handleMemberRemoved({
      workspaceId: second.id,
      userId: user.id,
      userRole: null,
    });
    expect(await memberships(issued.agent.id)).toEqual([
      { workspaceId: workspace.id, role: "agent" },
    ]);

    for (let i = 0; i < 5; i += 1) {
      expect((await issue(key)).status).toBe(200);
    }
    const keys = await db
      .select({ id: schema.apikeyTable.id })
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, issued.agent.id));
    expect(keys).toHaveLength(4);
  });

  it("lists the owner's agents without key secrets", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body as Issued;

    mockAuthenticatedSession(user);
    const list = await call("GET", "/agent-identity", null);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: issued.agent.id,
        name: "successor bb · Claude Code",
        disabledAt: null,
        archivedAt: null,
        keys: [
          expect.objectContaining({
            id: issued.keyId,
            expiresAt: expect.any(String),
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(issued.key);
  });

  it("keeps a viewer's agent a viewer and moves older agents to the agent role", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const viewing = await addWorkspace(user.id, "viewer");
    const issued = (await issue(await ownerKey(user.id))).body as Issued;
    const byWorkspace = async () =>
      new Map(
        (await memberships(issued.agent.id)).map((row) => [
          row.workspaceId,
          row.role,
        ]),
      );
    expect(await byWorkspace()).toEqual(
      new Map([
        [workspace.id, "agent"],
        [viewing.id, "viewer"],
      ]),
    );

    // An agent issued before the agent role still holds its owner's admin.
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "admin" })
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, issued.agent.id),
        ),
      );
    expect(await realignAgentRoles()).toBe(1);
    expect(await byWorkspace()).toEqual(
      new Map([
        [workspace.id, "agent"],
        [viewing.id, "viewer"],
      ]),
    );
    expect(await realignAgentRoles()).toBe(0);
  });

  it("keeps a workspace's own older agent role for the people on it and seeds the real one", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const person = await addWorkspaceMember(workspace.id, "agent");
    const agentRole = and(
      eq(schema.workspaceRoleTable.workspaceId, workspace.id),
      eq(schema.workspaceRoleTable.role, AGENT_ROLE_NAME),
    );
    await db.delete(schema.workspaceRoleTable).where(agentRole);
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: AGENT_ROLE_NAME,
      permission: JSON.stringify(defaultRolePayloads.viewer),
      createdAt: new Date(),
    });
    await db.insert(schema.invitationTable).values({
      workspaceId: workspace.id,
      email: "later@example.com",
      role: "agent",
      inviterId: user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await seedDefaultWorkspaceRoles();

    const roles = new Map(
      (
        await db
          .select({
            role: schema.workspaceRoleTable.role,
            permission: schema.workspaceRoleTable.permission,
          })
          .from(schema.workspaceRoleTable)
          .where(eq(schema.workspaceRoleTable.workspaceId, workspace.id))
      ).map((row) => [row.role, JSON.parse(row.permission)]),
    );
    expect(roles.get("agent")).toEqual(defaultRolePayloads.agent);
    expect(roles.get("custom-agent")).toEqual(defaultRolePayloads.viewer);
    expect(await memberships(person.id)).toEqual([
      { workspaceId: workspace.id, role: "custom-agent" },
    ]);
    const [invitation] = await db
      .select({ role: schema.invitationTable.role })
      .from(schema.invitationTable);
    expect(invitation?.role).toBe("custom-agent");
  });

  it("resets an agent role nobody but agents holds", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const agentRole = and(
      eq(schema.workspaceRoleTable.workspaceId, workspace.id),
      eq(schema.workspaceRoleTable.role, AGENT_ROLE_NAME),
    );
    await db
      .update(schema.workspaceRoleTable)
      .set({ permission: JSON.stringify(defaultRolePayloads.admin) })
      .where(agentRole);

    await seedDefaultWorkspaceRoles();

    const rows = await db
      .select({ permission: schema.workspaceRoleTable.permission })
      .from(schema.workspaceRoleTable)
      .where(agentRole);
    expect(rows.map((row) => JSON.parse(row.permission))).toEqual([
      defaultRolePayloads.agent,
    ]);
  });

  it("never lets an agent do more than the agent role, whatever its owner's custom role allows", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const lead = await addWorkspace(user.id, "lead");
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: lead.id,
      role: "lead",
      permission: JSON.stringify({
        ...defaultRolePayloads.agent,
        label: ["create", "read"],
      }),
      createdAt: new Date(),
    });
    const key = await ownerKey(user.id);
    const issued = (await issue(key)).body as Issued;
    expect(await memberships(issued.agent.id)).toContainEqual({
      workspaceId: lead.id,
      role: "lead",
    });
    const label = { name: "Urgent", color: "#f00", workspaceId: lead.id };

    expect((await call("POST", "/label", key, label)).status).toBe(200);
    const byAgent = await call("POST", "/label", issued.key, label);
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.missingPermissions).toEqual(["label:create"]);

    const caps = await call(
      "GET",
      `/workspace/${lead.id}/capabilities`,
      issued.key,
    );
    expect(caps.status).toBe(200);
    for (const [name, allowed] of Object.entries(
      caps.body as Record<string, boolean>,
    )) {
      if (!allowed) continue;
      const needs = workspaceCapabilities[name as WorkspaceCapability];
      for (const [resource, actions] of Object.entries(needs)) {
        for (const action of actions) {
          expect(
            (agent.statements as Record<string, readonly string[]>)[resource],
            `${name} needs ${resource}:${action}`,
          ).toContain(action);
        }
      }
    }
  });

  it("refuses to add an agent to a workspace by hand", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const stranger = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body as Issued;
    await expect(
      addWorkspaceMemberAsAdmin({
        workspaceId: stranger.workspace.id,
        userId: issued.agent.id,
        role: "admin",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
