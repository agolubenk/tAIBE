import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import removeWorkspaceMember from "../../apps/api/src/admin/controllers/remove-workspace-member";
import transferWorkspaceOwnership from "../../apps/api/src/admin/controllers/transfer-workspace-ownership";
import updateWorkspaceMemberRole from "../../apps/api/src/admin/controllers/update-workspace-member-role";
import {
  AGENTS_SETTINGS_PATH,
  MAX_AGENTS_PER_OWNER,
} from "../../apps/api/src/agent-identity/issue-agent-key";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import deleteAccountData from "../../apps/api/src/user/controllers/delete-account-data";
import updateMemberProjectAccess from "../../apps/api/src/workspace/controllers/update-member-project-access";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

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

async function ownerKey(userId: string, expiresIn?: number) {
  const { key, id } = await auth.api.createApiKey({
    body: { userId, name: "Owner key" },
  });
  if (expiresIn) {
    await db
      .update(schema.apikeyTable)
      .set({ expiresAt: new Date(Date.now() + expiresIn * 1000) })
      .where(eq(schema.apikeyTable.id, id));
  }
  return key;
}

async function issue(key: string, session = "successor bb") {
  const res = await call("POST", "/agent-identity/session", key, {
    harness: "claude-code",
    session,
  });
  return { status: res.status, body: res.body as Issued };
}

async function works(workspaceId: string, key: string) {
  return (await call("GET", `/forest/${workspaceId}/work-state`, key)).status;
}

async function addMember(workspaceId: string, role: string) {
  const id = `user-${randomUUID()}`;
  await db.insert(schema.userTable).values({
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: "Colleague",
  });
  await db
    .insert(schema.workspaceUserTable)
    .values({ workspaceId, userId: id, role, joinedAt: new Date() });
  return id;
}

async function role(workspaceId: string, userId: string) {
  const [row] = await db
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
  return row?.role ?? null;
}

describe("API integration: an agent follows its owner (R-010)", () => {
  beforeEach(resetTestDatabase);

  it("stops every key of an agent once it is disabled or its owner is banned", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body;
    expect(await works(workspace.id, issued.key)).toBe(200);

    await db
      .update(schema.userTable)
      .set({ banned: true })
      .where(eq(schema.userTable.id, user.id));
    expect(await works(workspace.id, issued.key)).toBe(401);
    await db
      .update(schema.userTable)
      .set({ banned: false })
      .where(eq(schema.userTable.id, user.id));
    expect(await works(workspace.id, issued.key)).toBe(200);

    // A key that outlived the revocation, e.g. issued in the same instant.
    await db
      .update(schema.agentProfileTable)
      .set({ disabledAt: new Date() })
      .where(eq(schema.agentProfileTable.userId, issued.agent.id));
    expect(await works(workspace.id, issued.key)).toBe(401);
  });

  it("takes the agents along when the owner leaves a workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addMember(workspace.id, "member");
    const issued = (await issue(await ownerKey(member))).body;
    expect(await role(workspace.id, issued.agent.id)).toBe("agent");

    const token = `leave-${randomUUID()}`;
    await db.insert(schema.sessionTable).values({
      id: randomUUID(),
      userId: member,
      token,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await auth.handler(
      new Request("http://localhost:1337/api/auth/organization/leave", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ organizationId: workspace.id }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await role(workspace.id, issued.agent.id)).toBeNull();
    expect(await role(workspace.id, owner.id)).toBe("owner");
  });

  it("removes an agent only together with its owner", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addMember(workspace.id, "member");
    const issued = (await issue(await ownerKey(member))).body;

    await expect(
      removeWorkspaceMember({
        workspaceId: workspace.id,
        userId: issued.agent.id,
      }),
    ).rejects.toThrow("together with its owner");

    const [agentMember] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, issued.agent.id),
        ),
      );
    const token = `remove-${randomUUID()}`;
    await db.insert(schema.sessionTable).values({
      id: randomUUID(),
      userId: owner.id,
      token,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await auth.handler(
      new Request("http://localhost:1337/api/auth/organization/remove-member", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          organizationId: workspace.id,
          memberIdOrEmail: agentMember?.id,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await role(workspace.id, issued.agent.id)).toBe("agent");

    await removeWorkspaceMember({ workspaceId: workspace.id, userId: member });
    expect(await role(workspace.id, issued.agent.id)).toBeNull();
  });

  it("lets a sole owner with agents delete the account, agents included", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body;

    await deleteAccountData(user.id);

    const [agent] = await db
      .select({ id: schema.userTable.id })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, issued.agent.id));
    expect(agent).toBeUndefined();
    const [left] = await db
      .select({ id: schema.workspaceTable.id })
      .from(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, workspace.id));
    expect(left).toBeUndefined();
  });

  it("gives an agent no role or access of its own and follows the owner's at once", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addMember(workspace.id, "admin");
    const issued = (await issue(await ownerKey(member))).body;
    expect(await role(workspace.id, issued.agent.id)).toBe("agent");

    await expect(
      transferWorkspaceOwnership({
        workspaceId: workspace.id,
        userId: issued.agent.id,
      }),
    ).rejects.toThrow("follow its owner");
    await expect(
      updateWorkspaceMemberRole({
        workspaceId: workspace.id,
        userId: issued.agent.id,
        role: "member",
      }),
    ).rejects.toThrow("follow its owner");
    await expect(
      updateMemberProjectAccess({
        workspaceId: workspace.id,
        actorId: owner.id,
        userId: issued.agent.id,
        projectAccess: "all",
        projectIds: [],
      }),
    ).rejects.toThrow("follow its owner");

    // An owner narrowed below the agent role takes the agent down with them.
    await updateWorkspaceMemberRole({
      workspaceId: workspace.id,
      userId: member,
      role: "viewer",
    });
    expect(await role(workspace.id, issued.agent.id)).toBe("viewer");
  });

  it("reserves the agents' addresses and never opens a session for an agent", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const issued = (await issue(await ownerKey(user.id))).body;
    const [agent] = await db
      .select({ email: schema.userTable.email })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, issued.agent.id));

    await expect(
      auth.api.signUpEmail({
        body: {
          email: "someone@agents.t-boards.invalid",
          password: "long-enough-password",
          name: "Squatter",
        },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.signInEmail({
        body: { email: agent?.email ?? "", password: "long-enough-password" },
      }),
    ).rejects.toThrow();
    const sessions = await db
      .select({ id: schema.sessionTable.id })
      .from(schema.sessionTable)
      .where(eq(schema.sessionTable.userId, issued.agent.id));
    expect(sessions).toHaveLength(0);
  });

  it("names long sessions, ends with a shorter issuer key and caps agents", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id, 2 * 60 * 60);

    const long = await issue(key, "kimi review r010 pass2 with a long label");
    expect(long.status).toBe(200);
    expect(long.body.agent.name).toBe(
      "kimi review r010 pass2 with a long label · Claude Code",
    );
    const expiresAt = new Date(long.body.expiresAt ?? 0).getTime();
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60 * 1000);

    // The case of the first label names the agent from then on.
    const again = await issue(key, "KIMI review r010 pass2 with a long label");
    expect(again.body.agent.id).toBe(long.body.agent.id);
    expect(again.body.agent.session).toBe(
      "kimi review r010 pass2 with a long label",
    );

    const filler = Array.from({ length: MAX_AGENTS_PER_OWNER - 1 }, (_, i) => ({
      id: `agent-filler-${i}-${randomUUID()}`,
      email: `filler-${i}-${randomUUID()}@agents.t-boards.invalid`,
      name: `filler ${i}`,
      emailVerified: false,
      role: "agent",
    }));
    await db.insert(schema.userTable).values(filler);
    await db.insert(schema.agentProfileTable).values(
      filler.map((row, i) => ({
        userId: row.id,
        ownerId: user.id,
        harness: "codex",
        session: `filler ${i}`,
      })),
    );
    const refused = await call("POST", "/agent-identity/session", key, {
      harness: "claude-code",
      session: "one too many",
    });
    expect(refused.status).toBe(403);
    // The agent cannot free a place: the text says the owner does, and where (TB-72).
    expect(refused.body.message).toContain("only the owner can disable");
    expect(refused.body.message).toContain(AGENTS_SETTINGS_PATH);
    // An agent that already exists keeps getting keys.
    expect(
      (await issue(key, "kimi review r010 pass2 with a long label")).status,
    ).toBe(200);
  });
});
