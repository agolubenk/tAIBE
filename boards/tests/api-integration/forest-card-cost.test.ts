import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { writeJournal } from "../../apps/api/src/forest/journal";
import { createModernMcpHandler } from "../../apps/api/src/mcp/modern";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";
import { addRestrictedMember, asMember } from "./helpers/forest-members";

const protocolVersion = "2026-07-28";

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-protocol-version": protocolVersion,
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": {
            name: "kaneo-card-cost-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

const callRows = () =>
  db
    .select()
    .from(agentJournalTable)
    .where(eq(agentJournalTable.action, "mcp.call"));

const tokensOf = (rows: { detail: string | null }[]) =>
  rows.reduce((sum, row) => sum + JSON.parse(row.detail ?? "{}").tokens, 0);

// TB-44 (R-036): a card's MCP spend — answered calls that named it by taskId
// and the tokens of their answers, per caller — read back through the API.
describe("API integration: card cost from the MCP journal (TB-44)", () => {
  beforeEach(resetTestDatabase);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("files calls about a card under it and sums them per caller", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Card with spend");
    const other = await addTask(forest.project.id, "Another card");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("refused-card")
          ? Response.json({ message: "forbidden" }, { status: 403 })
          : Response.json({ id: card!.id, title: "Card with spend" }),
      ),
    );
    const mcp = createModernMcpHandler(
      { token: "test-token", userId: forest.ownerId },
      "http://api.test",
    );

    await mcp.fetch(toolCall(1, "get_task", { taskId: card!.id }));
    await mcp.fetch(toolCall(2, "get_task", { taskId: card!.id }));
    await mcp.fetch(
      toolCall(3, "create_task_comment", { taskId: card!.id, content: "Done" }),
    );
    await mcp.fetch(toolCall(4, "list_task_comments", { taskId: card!.id }));
    await mcp.fetch(toolCall(5, "get_task", { taskId: other!.id }));
    // Refused and without a taskId: not on any card.
    await mcp.fetch(toolCall(6, "get_task", { taskId: "refused-card" }));
    await mcp.fetch(toolCall(7, "list_workspaces", {}));
    await vi.waitFor(async () => expect(await callRows()).toHaveLength(7));
    vi.unstubAllGlobals();

    const rows = await callRows();
    const onCard = rows.filter((row) => row.targetId === card!.id);
    expect(onCard.map((row) => row.targetType)).toEqual([
      "task",
      "task",
      "task",
      "task",
    ]);
    const refused = rows.find((row) => row.outcome === "denied");
    expect(refused).toMatchObject({
      targetType: "mcp_tool",
      targetId: "get_task",
    });
    expect(
      rows.find((row) => row.targetId === "list_workspaces"),
    ).toMatchObject({ targetType: "mcp_tool" });
    // The tool stays readable once the row is filed under the card.
    const detail = JSON.parse(
      onCard.find((row) => row.detail?.includes("create_task_comment"))
        ?.detail ?? "{}",
    );
    expect(detail.tool).toBe("create_task_comment");
    expect(JSON.parse(detail.args).taskId).toBe(card!.id);

    await db.insert(schema.cardMetaTable).values({
      taskId: card!.id,
      workspaceId: forest.workspace.id,
      tokens: 1200,
      costUsd: "0.4200",
      updatedBy: "agent:dev-1",
    });
    const cost = await forest.owner(`/cards/${card!.id}/cost`);
    expect(cost.status).toBe(200);
    expect(cost.body).toMatchObject({
      taskId: card!.id,
      calls: 4,
      tokens: tokensOf(onCard),
      truncated: false,
      card: { tokens: 1200, costUsd: 0.42 },
    });
    expect(cost.body.actors).toEqual([
      expect.objectContaining({
        actor: `bearer:${forest.ownerId}`,
        calls: 4,
        tokens: tokensOf(onCard),
      }),
    ]);

    const otherCost = await forest.owner(`/cards/${other!.id}/cost`);
    expect(otherCost.body).toMatchObject({ calls: 1, card: { tokens: null } });
  });

  it("counts neither rows written before TB-44 nor refused ones, and keeps one broken row from failing the sum", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id);
    const actor = {
      kind: "agent" as const,
      id: "bearer:u",
      name: "bearer:u",
      userId: forest.ownerId,
    };
    const row = (
      targetType: string,
      targetId: string,
      detail: string,
      outcome: "allowed" | "denied" = "allowed",
    ) =>
      writeJournal({
        workspaceId: null,
        actor,
        action: "mcp.call",
        targetType,
        targetId,
        outcome,
        detail,
      });
    await row(
      "mcp_tool",
      "get_task",
      '{"bytes":10,"tokens":7,"ms":1,"args":"{}"}',
    );
    await row("task", card!.id, '{"tool":"get_task","tokens":5}');
    await row("task", card!.id, '{"tool":"get_task","tokens":');
    await row("task", card!.id, '{"tool":"get_task","tokens":100}', "denied");

    const cost = await forest.owner(`/cards/${card!.id}/cost`);
    expect(cost.status).toBe(200);
    expect(cost.body).toMatchObject({ calls: 2, tokens: 5 });
  });

  it("answers only those who may open the card's project", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id);
    const member = await addRestrictedMember(forest.workspace.id);

    const refused = await asMember(member)(
      `/forest/${forest.workspace.id}/cards/${card!.id}/cost`,
    );
    expect(refused.status).toBe(403);

    const unknown = await forest.owner("/cards/no-such-card/cost");
    expect(unknown.status).toBe(404);
  });
});
