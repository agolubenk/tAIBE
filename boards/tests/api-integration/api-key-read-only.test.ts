import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { WORKSPACE_RESOLVED_PREFIXES } from "../../apps/api/src/utils/scoped-api-key-routes";
import { resetTestDatabase } from "./helpers/database";
import { readErrorBody } from "./helpers/error-body";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// TB-96: a key with metadata { access: "read" } reads and never writes.
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

async function seed() {
  const { user, workspace } = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: workspace.id,
    slug: "tb",
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Read-only key target",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    })
    .returning();
  return { user, workspace, project, task };
}

async function createKey(userId: string, metadata?: Record<string, unknown>) {
  const { key } = await auth.api.createApiKey({
    body: { userId, name: "Read-only key test", metadata },
  });
  return key;
}

function call(
  path: string,
  key: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  const { app } = createApp();
  return app.request(path, {
    method: init.method ?? "GET",
    headers: {
      "x-api-key": key,
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body,
  });
}

function comment(taskId: string, key: string, headers = {}) {
  return call(`/api/comment/${taskId}`, key, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Written by a key" }),
  });
}

async function comments(taskId: string, key: string) {
  const response = await call(`/api/comment/${taskId}`, key);
  expect(response.status).toBe(200);
  return (await response.json()) as unknown[];
}

describe("API integration: read-only API keys (TB-96)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("lets a read-only key read with GET and HEAD", async () => {
    const { user, workspace, project, task } = await seed();
    for (const metadata of [
      { access: "read" },
      { access: "read", workspaceId: workspace.id },
    ]) {
      const key = await createKey(user.id, metadata);
      const label = JSON.stringify(metadata);
      expect(
        (await call(`/api/project/${project.id}`, key)).status,
        label,
      ).toBe(200);
      expect(
        (await call(`/api/task/by-ticket-id/TB-1`, key)).status,
        label,
      ).toBe(200);
      expect(await comments(task.id, key), label).toEqual([]);
      expect(
        (await call(`/api/project/${project.id}`, key, { method: "HEAD" }))
          .status,
        label,
      ).toBe(200);
      expect((await call("/api/auth/get-session", key)).status, label).toBe(
        200,
      );
    }
  });

  it("refuses every write method under every workspace prefix", async () => {
    const { user, workspace, project } = await seed();
    for (const metadata of [
      { access: "read" },
      { access: "read", workspaceId: workspace.id },
    ]) {
      const key = await createKey(user.id, metadata);
      for (const prefix of WORKSPACE_RESOLVED_PREFIXES) {
        for (const method of WRITE_METHODS) {
          const response = await call(`${prefix}/${project.id}`, key, {
            method,
            body: "{}",
          });
          const label = `${JSON.stringify(metadata)} ${method} ${prefix}`;
          expect(response.status, label).toBe(403);
          expect((await readErrorBody(response)).code, label).toBe(
            "API_KEY_READ_ONLY",
          );
        }
      }
    }
    const [stillThere] = await db
      .select({ id: schema.projectTable.id })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.id, project.id));
    expect(stillThere?.id).toBe(project.id);
  });

  it("does not let a method override header turn a write into a read", async () => {
    const { user, task } = await seed();
    const key = await createKey(user.id, { access: "read" });
    for (const header of [
      "X-HTTP-Method-Override",
      "X-HTTP-Method",
      "X-Method-Override",
    ]) {
      const response = await comment(task.id, key, { [header]: "GET" });
      expect(response.status, header).toBe(403);
    }
    expect(await comments(task.id, key)).toEqual([]);
  });

  it("refuses key and session management through /auth to a read-only key", async () => {
    const { user } = await seed();
    const key = await createKey(user.id, { access: "read" });
    const minted = await call("/api/auth/api-key/create", key, {
      method: "POST",
      body: JSON.stringify({ name: "wider key" }),
    });
    expect(minted.status).toBe(403);
    expect((await readErrorBody(minted)).code).toBe("API_KEY_READ_ONLY");
    const keys = await db
      .select({ id: schema.apikeyTable.id })
      .from(schema.apikeyTable);
    expect(keys).toHaveLength(1);
  });

  it("answers API_KEY_READ_ONLY before the scope and session checks", async () => {
    const { user, workspace, project } = await seed();
    const unscoped = await createKey(user.id, { access: "read" });
    const scoped = await createKey(user.id, {
      access: "read",
      workspaceId: workspace.id,
    });
    const writes: Array<[string, string, string]> = [
      // Account management: SESSION_REQUIRED came first before.
      ["unscoped", unscoped, "/api/auth/api-key/create"],
      ["bearer", unscoped, "/api/auth/api-key/create"],
      // Outside the key's workspace routes: API_KEY_WORKSPACE_SCOPE came first.
      ["scoped", scoped, "/api/auth/organization/create"],
      ["scoped", scoped, `/api/gitlab-integration/project/${project.id}`],
    ];
    for (const [kind, key, path] of writes) {
      const response = await call(path, key, {
        method: "POST",
        headers:
          kind === "bearer"
            ? { "x-api-key": "", authorization: `Bearer ${key}` }
            : {},
        body: "{}",
      });
      const label = `${kind} POST ${path}`;
      expect(response.status, label).toBe(403);
      expect((await readErrorBody(response)).code, label).toBe(
        "API_KEY_READ_ONLY",
      );
    }
  });

  it("does not give a read-only key the GitLab or Gitea webhook secret (R-017)", async () => {
    const { user, project } = await seed();
    const webhookSecret = ["tb96", "webhook", "secret"].join("-");
    await db.insert(schema.integrationTable).values([
      {
        projectId: project.id,
        type: "gitlab",
        isActive: true,
        config: JSON.stringify({
          baseUrl: "https://gitlab.example",
          projectPath: "group/project",
          accessToken: "fake-gitlab-test-token",
          webhookSecret,
        }),
      },
      {
        projectId: project.id,
        type: "gitea",
        isActive: true,
        config: JSON.stringify({
          baseUrl: "https://gitea.example",
          repositoryOwner: "group",
          repositoryName: "project",
          accessToken: "fake-gitea-test-token",
          webhookSecret,
        }),
      },
    ]);
    const read = async (key: string, kind: "gitlab" | "gitea") => {
      const response = await call(
        `/api/${kind}-integration/project/${project.id}`,
        key,
      );
      expect(response.status, kind).toBe(200);
      return (await response.json()) as {
        webhookSecret: string;
        maskedAccessToken: string;
      };
    };

    const full = await createKey(user.id, { access: "full" });
    expect((await read(full, "gitlab")).webhookSecret).toBe(webhookSecret);
    expect((await read(full, "gitea")).webhookSecret).toBe(webhookSecret);

    const readOnly = await createKey(user.id, { access: "read" });
    const gitlab = await read(readOnly, "gitlab");
    expect(gitlab.webhookSecret).toBe("");
    expect(gitlab.maskedAccessToken).toBe("");
    expect((await read(readOnly, "gitea")).webhookSecret).toBe("");
  });

  it("refuses agent keys and the agent list to a read-only key (R-016)", async () => {
    const { user } = await seed();
    const key = await createKey(user.id, { access: "read" });
    const list = await call("/api/agent-identity", key);
    expect(list.status).toBe(403);
    expect(((await list.json()) as { message: string }).message).toContain(
      "agent_forbidden",
    );
    const issue = await call("/api/agent-identity/session", key, {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", session: "tb96" }),
    });
    expect(issue.status).toBe(403);
    expect((await readErrorBody(issue)).code).toBe("API_KEY_READ_ONLY");
    const agents = await db
      .select({ id: schema.userTable.id })
      .from(schema.userTable)
      .where(eq(schema.userTable.role, "agent"));
    expect(agents).toEqual([]);
  });

  it("does not open MCP to a read-only key as a bearer or x-api-key", async () => {
    const { user } = await seed();
    const key = await createKey(user.id, { access: "read" });
    const initialize = (headers: Record<string, string>) =>
      call("/api/mcp", key, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "initialize",
          "mcp-protocol-version": "2026-07-28",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "tb96-read-key", version: "1.0.0" },
          },
        }),
      });
    // call() always sends x-api-key; the second request adds the key as a bearer.
    expect((await initialize({})).status, "x-api-key only").toBe(401);
    expect(
      (await initialize({ authorization: `Bearer ${key}` })).status,
      "bearer and x-api-key",
    ).toBe(401);
  });

  it("treats an unknown access value as read-only", async () => {
    const { user, task } = await seed();
    const key = await createKey(user.id, { access: "write" });
    const response = await comment(task.id, key);
    expect(response.status).toBe(403);
    expect((await readErrorBody(response)).code).toBe("API_KEY_READ_ONLY");
  });

  it("keeps keys without the field as they were", async () => {
    const { user, workspace, task } = await seed();
    for (const metadata of [
      undefined,
      { workspaceId: workspace.id },
      { access: "full" },
    ]) {
      const key = await createKey(user.id, metadata);
      const response = await comment(task.id, key);
      expect(response.status, JSON.stringify(metadata ?? null)).toBe(200);
    }
    expect(await comments(task.id, await createKey(user.id))).toHaveLength(3);
  });
});
