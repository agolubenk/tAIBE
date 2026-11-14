import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db from "../../apps/api/src/database";
import { agentJournalTable } from "../../apps/api/src/database/forest-schema";
import { createModernMcpHandler } from "../../apps/api/src/mcp/modern";
import { resetTestDatabase } from "./helpers/database";

const protocolVersion = "2026-07-28";
const secret = "postgres://probe:not-a-real-pass@db.local:5432/x";

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
            name: "kaneo-call-journal-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function callRows() {
  return db
    .select()
    .from(agentJournalTable)
    .where(eq(agentJournalTable.action, "mcp.call"));
}

describe("API integration: MCP call journal (R-036)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    // The API refuses the task whose id carries the secret, so that call
    // reaches the journal as denied.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("not-a-real-pass")
          ? Response.json({ message: "forbidden" }, { status: 403 })
          : Response.json({ id: "task-1", title: "Probe tree" }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("journals each call with its size, and redacts secrets in the arguments", async () => {
    const handler = createModernMcpHandler(
      { token: "test-token", userId: "user-1" },
      "http://api.test",
    );

    const answered = await handler.fetch(
      toolCall(1, "get_task", { taskId: "task-1" }),
    );
    expect(answered.status).toBe(200);
    await handler.fetch(toolCall(2, "get_task", { taskId: secret }));

    await vi.waitFor(async () => expect(await callRows()).toHaveLength(2));
    const rows = await callRows();
    const allowed = rows.find((row) => row.outcome === "allowed");
    const denied = rows.find((row) => row.outcome === "denied");

    expect(allowed).toMatchObject({
      workspaceId: null,
      actorKind: "agent",
      actorId: "bearer:user-1",
      // TB-44: an answered call that names a card is filed under it.
      targetType: "task",
      targetId: "task-1",
    });
    // A refused call keeps the tool as its target: its taskId is not trusted.
    expect(denied).toMatchObject({
      targetType: "mcp_tool",
      targetId: "get_task",
    });
    const detail = JSON.parse(allowed?.detail ?? "{}");
    expect(detail.tool).toBe("get_task");
    expect(detail.bytes).toBeGreaterThan(0);
    expect(detail.tokens).toBeGreaterThan(0);
    expect(JSON.parse(detail.args)).toEqual({ taskId: "task-1" });

    expect(denied?.detail).not.toContain("not-a-real-pass");
    expect(denied?.detail).toContain("[REDACTED:db_url]");
  });
});
