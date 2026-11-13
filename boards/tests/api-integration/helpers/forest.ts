import { eq } from "drizzle-orm";
import { expect } from "vite-plus/test";
import { auth } from "../../../apps/api/src/auth";
import db, { schema } from "../../../apps/api/src/database";
import { createApp } from "../../../apps/api/src/index";
import { mockAuthenticatedSession } from "./auth";
import { createProjectFixture, createWorkspaceMember } from "./fixtures";

// The owner is an instance admin who owns the workspace; the agent is an API
// key of the same user, so only the credential tells them apart (N-011).
export async function createForest() {
  const { user, workspace } = await createWorkspaceMember({ role: "owner" });
  const [owner] = await db
    .update(schema.userTable)
    .set({ role: "admin" })
    .where(eq(schema.userTable.id, user.id))
    .returning();
  const { project } = await createProjectFixture({
    workspaceId: workspace.id,
  });
  const { key } = await auth.api.createApiKey({
    body: { userId: user.id, name: "Forest agent" },
  });
  const { app } = createApp();

  const request = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  };
  const call = (
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    request(
      body === undefined ? "GET" : "POST",
      `/forest/${workspace.id}${path}`,
      headers,
      body,
    );
  const agentHeaders = (session?: string): Record<string, string> => ({
    "x-api-key": key,
    ...(session ? { "x-t-boards-session": session } : {}),
  });

  return {
    workspace,
    project,
    ownerId: user.id,
    key,
    owner: (path: string, body?: unknown) => {
      mockAuthenticatedSession(owner as typeof user);
      return call(path, {}, body);
    },
    agent: (path: string, body?: unknown, session?: string) =>
      call(path, agentHeaders(session), body),
    // Any /api route, for the agent guard on kaneo's own routes.
    agentApi: (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      session?: string,
    ) => request(method, path, { ...agentHeaders(session), ...headers }, body),
    ownerApi: (method: string, path: string, body?: unknown) => {
      mockAuthenticatedSession(owner as typeof user);
      return request(method, path, {}, body);
    },
  };
}

export async function addTask(projectId: string, title = "Task") {
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId, title, status: "to-do", number: null })
    .returning();
  return task;
}

export async function relate(
  sourceTaskId: string,
  targetTaskId: string,
  relationType: "subtask" | "blocks" | "related" = "subtask",
) {
  await db
    .insert(schema.taskRelationTable)
    .values({ sourceTaskId, targetTaskId, relationType });
}

type Forest = Awaited<ReturnType<typeof createForest>>;

// An agent asks the owner; close_task carries the done reference it needs.
export async function requestApproval(
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
export async function approve(
  forest: Forest,
  action: "close_task" | "reopen_task" | "set_priority",
  targetId: string,
  value: string,
) {
  const id = await requestApproval(forest, action, targetId, value);
  const decided = await forest.owner(`/approvals/${id}/decide`, {
    decision: "approved",
  });
  expect(decided.status).toBe(200);
  expect(decided.body.status).toBe("consumed");
  return id;
}
