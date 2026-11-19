import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { defaultCounter } from "../view/wire-format.js";
import { createRegisterTool, run, type ToolCall } from "./register-tool.js";

type Handler = (args: unknown) => Promise<CallToolResult>;

function setup(onCall: (call: ToolCall) => void) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) =>
      handlers.set(name, handler),
  };
  const client = { usingApiKey: false, json: vi.fn() };
  const registerTool = createRegisterTool(server as never, client, { onCall });
  registerTool(
    "get_task",
    { description: "", inputSchema: z.object({ id: z.string() }) },
    async (args) => run(async () => ({ id: args.id, title: "Tree" })),
  );
  return (name: string, args: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no ${name}`);
    return handler(args);
  };
}

describe("createRegisterTool onCall (R-036)", () => {
  it("records the tool, the sent arguments and the answer size", async () => {
    const calls: ToolCall[] = [];
    const call = setup((c) => calls.push(c));

    const result = await call("get_task", { id: "t1", budget: 300 });
    const text = (result.content[0] as { text: string }).text;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "get_task",
      args: { id: "t1", budget: 300 },
      ok: true,
      bytes: new TextEncoder().encode(text).length,
      tokens: defaultCounter.count(text),
    });
    expect(calls[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("records a refused call too", async () => {
    const calls: ToolCall[] = [];
    const call = setup((c) => calls.push(c));

    const result = await call("get_task", { id: 5 });

    expect(result.isError).toBe(true);
    expect(calls[0]).toMatchObject({ tool: "get_task", ok: false });
  });

  it("tells the journal which session made the call (TB-135)", async () => {
    const calls: ToolCall[] = [];
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) =>
        handlers.set(name, handler),
    };
    const client = { usingApiKey: false, json: vi.fn() };
    createRegisterTool(server as never, client, {
      onCall: (c) => calls.push(c),
      agentIdentity: { defaultHarness: () => "claude-code" },
    })(
      "get_task",
      { description: "", inputSchema: z.object({ id: z.string() }) },
      async (args) => run(async () => ({ id: args.id })),
    );

    await handlers.get("get_task")?.({ id: "t1", session: "night-1" });
    await handlers.get("get_task")?.({ id: "t2" });

    expect(calls.map((c) => c.identity)).toEqual([
      { harness: "claude-code", session: "night-1" },
      { harness: "claude-code", session: undefined },
    ]);
  });

  it("answers even when the journal hook throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = setup(() => {
      throw new Error("journal down");
    });

    const result = await call("get_task", { id: "t1" });

    expect(result.isError).toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
