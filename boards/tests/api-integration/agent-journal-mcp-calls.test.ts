import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import db from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { addTask, createForest } from "./helpers/forest";

type Forest = Awaited<ReturnType<typeof createForest>>;

const PATH = "/agent-journal/mcp-calls";

const call = (tool: string, args: unknown, ok = true) => ({
  id: randomUUID(),
  tool,
  args,
  ok,
  bytes: 10,
  tokens: 7,
  ms: 3,
});

const callRows = () =>
  db
    .select()
    .from(agentJournalTable)
    .where(eq(agentJournalTable.action, "mcp.call"));

// The agent of one stdio session, with its own key (R-010).
async function sessionAgent(forest: Forest) {
  const issued = await forest.agentApi("POST", "/agent-identity/session", {
    harness: "claude-code",
    session: "bb",
  });
  expect(issued.status).toBe(200);
  return {
    id: String(issued.body.agent.id),
    name: String(issued.body.agent.name),
    key: String(issued.body.key),
  };
}

async function foreignCard() {
  const { workspace } = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({ workspaceId: workspace.id });
  return addTask(project.id, "Not yours");
}

const send = (
  forest: Forest,
  key: string,
  calls: unknown[],
  headers: Record<string, string> = {},
) => forest.agentApi("POST", PATH, { calls }, { "x-api-key": key, ...headers });

// TB-135 (R-036): what a stdio MCP server sends after its calls.
describe("API integration: MCP calls journaled from a stdio server", () => {
  beforeEach(resetTestDatabase);

  it("files a session's calls under its agent, counts them on the card and keeps one row per call id", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Card with spend");
    const foreign = await foreignCard();
    const agent = await sessionAgent(forest);
    const batch = [
      call("get_task", { taskId: card!.id }),
      call("get_task", { taskId: foreign!.id }),
      call("list_workspaces", {}),
    ];

    const sent = await send(forest, agent.key, batch);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ received: 3, journaled: 3 });

    const rows = await callRows();
    expect(new Set(rows.map((row) => row.actorId))).toEqual(
      new Set([`agent:${agent.id}`]),
    );
    expect(rows.every((row) => row.actorName === agent.name)).toBe(true);
    expect(rows.find((row) => row.targetId === card!.id)).toMatchObject({
      targetType: "task",
      outcome: "allowed",
    });
    // A card the agent cannot open stays under the tool.
    expect(rows.some((row) => row.targetId === foreign!.id)).toBe(false);
    expect(
      rows
        .filter((row) => row.targetType === "mcp_tool")
        .map((r) => r.targetId),
    ).toEqual(expect.arrayContaining(["get_task", "list_workspaces"]));

    const cost = await forest.owner(`/cards/${card!.id}/cost`);
    expect(cost.body).toMatchObject({ calls: 1, tokens: 7 });
    expect(cost.body.actors).toEqual([
      expect.objectContaining({
        actorId: `agent:${agent.id}`,
        actor: agent.name,
        calls: 1,
      }),
    ]);

    // The batch again, as after a lost answer: no second row.
    const again = await send(forest, agent.key, batch);
    expect(again.body).toEqual({ received: 3, journaled: 0 });
    expect(await callRows()).toHaveLength(3);
  });

  it("lets a session label name the session but never change whose key it is", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id);
    const agent = await sessionAgent(forest);

    await send(forest, agent.key, [call("get_task", { taskId: card!.id })], {
      "x-t-boards-session": "someone-else",
    });
    const [agentRow] = await callRows();
    expect(agentRow).toMatchObject({
      actorId: `agent:${agent.id}`,
      actorName: agent.name,
    });

    // Two keys giving the same label stay two callers on the card.
    const { key: secondKey } = await auth.api.createApiKey({
      body: { userId: forest.ownerId, name: "Second agent" },
    });
    for (const key of [forest.key, secondKey]) {
      const res = await send(
        forest,
        key,
        [call("get_task", { taskId: card!.id })],
        { "x-t-boards-session": "night-1" },
      );
      expect(res.status).toBe(200);
    }
    const labelled = (await callRows()).filter(
      (row) => row.actorName === "night-1",
    );
    expect(labelled).toHaveLength(2);
    expect(new Set(labelled.map((row) => row.actorId)).size).toBe(2);
    for (const row of labelled) {
      expect(row.actorId).toMatch(/^key:[^:]+:night-1$/);
    }

    const cost = await forest.owner(`/cards/${card!.id}/cost`);
    expect(cost.body.calls).toBe(3);
    expect(cost.body.actors).toHaveLength(3);
  });

  it("refuses a one-workspace key and a batch that is not 1 to 50 well-formed calls", async () => {
    const forest = await createForest();
    const { key: scopedKey } = await auth.api.createApiKey({
      body: {
        userId: forest.ownerId,
        name: "One workspace",
        metadata: { workspaceId: forest.workspace.id },
      },
    });

    const scoped = await send(forest, scopedKey, [call("whoami", {})]);
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe("API_KEY_WORKSPACE_SCOPE");

    const tooMany = Array.from({ length: 51 }, () => call("whoami", {}));
    expect((await send(forest, forest.key, tooMany)).status).toBe(400);
    expect((await send(forest, forest.key, [])).status).toBe(400);
    expect(
      (await send(forest, forest.key, [call("Get-Task", {})])).status,
    ).toBe(400);
    expect(
      (
        await send(forest, forest.key, [
          { ...call("whoami", {}), id: "not-a-uuid" },
        ])
      ).status,
    ).toBe(400);
    expect(await callRows()).toHaveLength(0);
  });
});

const protocolVersion = "2026-07-28";

async function signUp(app: ReturnType<typeof createApp>["app"]) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({
      name: "MCP user",
      email: `${randomUUID()}@example.com`,
      password: "mcp-session-label-password",
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    token: string;
    user: { id: string };
  };
  return { token: body.token, userId: body.user.id };
}

function remoteCall(
  app: ReturnType<typeof createApp>["app"],
  token: string,
  headers: Record<string, string> = {},
) {
  return app.request("/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-protocol-version": protocolVersion,
      "mcp-name": "list_workspaces",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_workspaces",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": {
            name: "kaneo-session-label-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

// TB-135: the remote /mcp names its rows by the client's session label.
describe("API integration: session label on the remote MCP", () => {
  beforeEach(resetTestDatabase);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("journals a labelled call under the token's user and the label", async () => {
    const { app } = createApp();
    const { token, userId } = await signUp(app);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );

    await remoteCall(app, token, { "x-t-boards-session": "night-1" });
    await remoteCall(app, token);
    await vi.waitFor(async () => expect(await callRows()).toHaveLength(2));

    const rows = await callRows();
    expect(rows.map((row) => [row.actorId, row.actorName]).sort()).toEqual(
      [
        [`bearer:${userId}`, `bearer:${userId}`],
        [`bearer:${userId}:night-1`, "night-1"],
      ].sort(),
    );
  });
});
