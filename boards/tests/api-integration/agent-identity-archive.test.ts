import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  AGENT_IDLE_ARCHIVE_MS,
  MAX_AGENTS_PER_OWNER,
} from "../../apps/api/src/agent-identity/agent-limits";
import { archiveIdleAgents } from "../../apps/api/src/agent-identity/archive-idle-agents";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

type Issued = {
  agent: { id: string; name: string; harness: string; session: string };
  key: string;
  keyId: string;
  expiresAt: string | null;
};

const HOUR = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR);
// Relative to the archive threshold (TB-100: 5 h), so the tests follow it.
const IDLE_H = AGENT_IDLE_ARCHIVE_MS / HOUR;
const idleAgo = () => hoursAgo(IDLE_H + 1);
const activeAgo = () => hoursAgo(IDLE_H - 1);

async function call(method: string, path: string, key: string, body?: unknown) {
  const { app } = createApp();
  const response = await app.request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ownerKey(userId: string) {
  const { key } = await auth.api.createApiKey({
    body: { userId, name: "Owner key" },
  });
  return key;
}

async function issue(key: string, session: string) {
  const res = await call("POST", "/agent-identity/session", key, {
    harness: "claude-code",
    session,
  });
  return { status: res.status, body: res.body as Issued };
}

async function issued(key: string, session: string) {
  const res = await issue(key, session);
  expect(res.status).toBe(200);
  return res.body;
}

async function profile(agentId: string) {
  const [row] = await db
    .select({
      disabledAt: schema.agentProfileTable.disabledAt,
      archivedAt: schema.agentProfileTable.archivedAt,
    })
    .from(schema.agentProfileTable)
    .where(eq(schema.agentProfileTable.userId, agentId));
  return row;
}

async function lastActive(agentId: string, at: Date) {
  await db
    .update(schema.agentProfileTable)
    .set({ lastIssuedAt: at })
    .where(eq(schema.agentProfileTable.userId, agentId));
}

async function keyCount(agentId: string) {
  const rows = await db
    .select({ id: schema.apikeyTable.id })
    .from(schema.apikeyTable)
    .where(eq(schema.apikeyTable.referenceId, agentId));
  return rows.length;
}

async function works(workspaceId: string, key: string) {
  return (await call("GET", `/forest/${workspaceId}/work-state`, key)).status;
}

// Agents of the owner stored directly, in the given state.
async function addAgents(
  ownerId: string,
  count: number,
  state: { disabledAt?: Date; archivedAt?: Date } = {},
) {
  const users = Array.from({ length: count }, (_, i) => ({
    id: `agent-filler-${randomUUID()}`,
    email: `filler-${i}-${randomUUID()}@agents.t-boards.invalid`,
    name: `filler ${i}`,
    emailVerified: false,
    role: "agent",
  }));
  if (!users.length) return;
  await db.insert(schema.userTable).values(users);
  await db.insert(schema.agentProfileTable).values(
    users.map((user, i) => ({
      userId: user.id,
      ownerId,
      harness: "codex",
      session: `filler ${i}`,
      lastIssuedAt: new Date(),
      ...state,
    })),
  );
}

describe("API integration: idle agents go to the archive (TB-74)", () => {
  beforeEach(resetTestDatabase);

  it("archives only enabled agents idle past the threshold and drops their keys", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const idle = await issued(key, "idle");
    const recent = await issued(key, "recent");
    const used = await issued(key, "used key");
    const off = await issued(key, "off");
    const before = await issued(key, "archived before");

    await lastActive(idle.agent.id, idleAgo());
    await lastActive(recent.agent.id, activeAgo());
    // Its last key went out long ago, but the session used one an hour ago.
    await lastActive(used.agent.id, idleAgo());
    await db
      .update(schema.apikeyTable)
      .set({ lastRequest: hoursAgo(1) })
      .where(eq(schema.apikeyTable.referenceId, used.agent.id));
    expect(
      (
        await call("PATCH", `/agent-identity/${off.agent.id}`, key, {
          enabled: false,
        })
      ).status,
    ).toBe(200);
    await lastActive(off.agent.id, hoursAgo(48));
    const archivedBefore = hoursAgo(30);
    await db
      .update(schema.agentProfileTable)
      .set({ archivedAt: archivedBefore, lastIssuedAt: hoursAgo(72) })
      .where(eq(schema.agentProfileTable.userId, before.agent.id));

    expect(await archiveIdleAgents()).toEqual({ archived: 1 });

    expect((await profile(idle.agent.id))?.archivedAt).toBeInstanceOf(Date);
    expect(await keyCount(idle.agent.id)).toBe(0);
    expect(await works(workspace.id, idle.key)).toBe(401);

    expect((await profile(recent.agent.id))?.archivedAt).toBeNull();
    expect(await works(workspace.id, recent.key)).toBe(200);
    expect((await profile(used.agent.id))?.archivedAt).toBeNull();
    expect(await profile(off.agent.id)).toEqual({
      disabledAt: expect.any(Date),
      archivedAt: null,
    });
    expect((await profile(before.agent.id))?.archivedAt?.getTime()).toBe(
      archivedBefore.getTime(),
    );

    // A second run finds nothing more.
    expect(await archiveIdleAgents()).toEqual({ archived: 0 });
  });

  it("refuses an archived agent's key even if it never expires, and brings it back on a new key", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const first = await issued(key, "lasting");
    await db
      .update(schema.apikeyTable)
      .set({ expiresAt: null })
      .where(eq(schema.apikeyTable.id, first.keyId));
    await db
      .update(schema.agentProfileTable)
      .set({ archivedAt: new Date() })
      .where(eq(schema.agentProfileTable.userId, first.agent.id));
    expect(await works(workspace.id, first.key)).toBe(401);

    const back = await issued(key, "lasting");
    expect(back.agent).toEqual(first.agent);
    expect((await profile(first.agent.id))?.archivedAt).toBeNull();
    expect(await works(workspace.id, back.key)).toBe(200);
  });

  it("counts only active agents and brings an archived one back while a place is free", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const returning = await issued(key, "comes back");
    const waiting = await issued(key, "waits");
    await lastActive(returning.agent.id, idleAgo());
    await lastActive(waiting.agent.id, idleAgo());
    expect(await archiveIdleAgents()).toEqual({ archived: 2 });

    await addAgents(user.id, MAX_AGENTS_PER_OWNER - 2);
    await addAgents(user.id, 10, { archivedAt: hoursAgo(30) });
    await addAgents(user.id, 5, { disabledAt: hoursAgo(30) });

    // cap − 2 active, plus 10 archived and 5 disabled: those hold no place.
    expect((await issue(key, "fresh")).status).toBe(200);
    const back = await issued(key, "comes back");
    expect(back.agent).toEqual(returning.agent);
    expect((await profile(returning.agent.id))?.archivedAt).toBeNull();

    // At the cap now: the archived agent waits for a place, still archived.
    const refused = await issue(key, "waits");
    expect(refused.status).toBe(403);
    expect((refused.body as unknown as { message: string }).message).toContain(
      "goes to the archive by itself",
    );
    expect((await profile(waiting.agent.id))?.archivedAt).toBeInstanceOf(Date);
    expect(await keyCount(waiting.agent.id)).toBe(0);
  });

  it("keeps a disabled agent out, and enabling moves it to the archive, not to work", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const agent = await issued(key, "switched");
    await lastActive(agent.agent.id, idleAgo());
    await archiveIdleAgents();

    // Disabled wins over the archive.
    const off = await call("PATCH", `/agent-identity/${agent.agent.id}`, key, {
      enabled: false,
    });
    expect(off.body).toMatchObject({ enabled: false, archived: false });
    expect(await profile(agent.agent.id)).toEqual({
      disabledAt: expect.any(Date),
      archivedAt: null,
    });
    const refused = await issue(key, "switched");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("disabled by its owner");
    expect((await profile(agent.agent.id))?.archivedAt).toBeNull();

    const on = await call("PATCH", `/agent-identity/${agent.agent.id}`, key, {
      enabled: true,
    });
    expect(on.body).toMatchObject({ enabled: true, archived: true });
    expect(await profile(agent.agent.id)).toEqual({
      disabledAt: null,
      archivedAt: expect.any(Date),
    });

    // It takes a place only when its session comes back.
    await addAgents(user.id, MAX_AGENTS_PER_OWNER);
    expect((await issue(key, "switched")).status).toBe(403);
    expect((await profile(agent.agent.id))?.archivedAt).toBeInstanceOf(Date);
  });

  it("lists active agents, then archived, then disabled", async () => {
    const { user } = await createWorkspaceMember({ role: "owner" });
    const key = await ownerKey(user.id);
    const off = await issued(key, "off");
    const archived = await issued(key, "archived");
    const active = await issued(key, "active");
    await call("PATCH", `/agent-identity/${off.agent.id}`, key, {
      enabled: false,
    });
    await lastActive(archived.agent.id, idleAgo());
    await archiveIdleAgents();

    const list = await call("GET", "/agent-identity", key);
    expect(list.status).toBe(200);
    const agents = list.body as {
      id: string;
      archivedAt: string | null;
      disabledAt: string | null;
      keys: unknown[];
    }[];
    expect(agents.map((a) => a.id)).toEqual([
      active.agent.id,
      archived.agent.id,
      off.agent.id,
    ]);
    expect(agents[0]).toMatchObject({ archivedAt: null, disabledAt: null });
    expect(agents[1]).toMatchObject({
      archivedAt: expect.any(String),
      disabledAt: null,
      keys: [],
    });
    expect(agents[2]).toMatchObject({
      archivedAt: null,
      disabledAt: expect.any(String),
    });
  });
});
