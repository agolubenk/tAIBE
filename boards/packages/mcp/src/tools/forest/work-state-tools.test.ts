import { describe, expect, it, vi } from "vite-plus/test";
import { registerTools } from "../register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup() {
  const tools = new Map<
    string,
    {
      schema: { safeParse: (v: unknown) => { success: boolean } };
      handler: Handler;
    }
  >();
  const server = {
    registerTool: vi.fn(
      (name: string, config: { inputSchema: never }, handler: Handler) => {
        tools.set(name, { schema: config.inputSchema, handler });
      },
    ),
  };
  const client = { json: vi.fn().mockResolvedValue({ ok: true }) };
  registerTools(server as never, { client: client as never });
  const tool = (name: string) => {
    const found = tools.get(name);
    if (!found) throw new Error(`${name} is not registered`);
    return found;
  };
  return { tool, client };
}

describe("forest work state tools", () => {
  it("puts the session's state under its session header", async () => {
    const { tool, client } = setup();

    const result = await tool("forest_set_work_state").handler({
      workspaceId: "ws",
      session: "dev #1",
      step: "Пишу тесты",
      taskId: "t1",
      waiting: "ревью",
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith("/api/forest/ws/work-state", {
      method: "PUT",
      headers: { "x-t-boards-session": "dev #1" },
      body: JSON.stringify({
        step: "Пишу тесты",
        taskId: "t1",
        waiting: "ревью",
      }),
    });
  });

  it("clears with DELETE and no body, and lists with GET", async () => {
    const { tool, client } = setup();

    await tool("forest_clear_work_state").handler({
      workspaceId: "ws",
      session: "dev #1",
    });
    await tool("forest_list_work_state").handler({ workspaceId: "ws" });

    expect(client.json).toHaveBeenNthCalledWith(
      1,
      "/api/forest/ws/work-state",
      {
        method: "DELETE",
        headers: { "x-t-boards-session": "dev #1" },
      },
    );
    expect(client.json).toHaveBeenNthCalledWith(
      2,
      "/api/forest/ws/work-state",
      {
        method: "GET",
        headers: {},
      },
    );
  });

  it("needs a session and a step to set the state", () => {
    const { tool } = setup();
    const { schema } = tool("forest_set_work_state");

    expect(schema.safeParse({ workspaceId: "ws", step: "шаг" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ workspaceId: "ws", session: "s", step: " " }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ workspaceId: "ws", session: "s", step: "шаг" })
        .success,
    ).toBe(true);
  });

  it("reads a card's memory", async () => {
    const { tool, client } = setup();

    await tool("forest_get_card_memory").handler({
      workspaceId: "ws",
      taskId: "t 1",
    });

    expect(client.json).toHaveBeenCalledWith(
      "/api/forest/ws/cards/t%201/memory",
      { method: "GET", headers: {} },
    );
  });

  it("reads memory by card key or queue item", async () => {
    const { tool, client } = setup();

    await tool("forest_get_card_memory").handler({
      workspaceId: "ws",
      ticketKey: "TB-108",
    });
    await tool("forest_get_card_memory").handler({
      workspaceId: "ws",
      queueItemId: "d-tb113-mem-1311",
    });

    expect(client.json).toHaveBeenNthCalledWith(
      1,
      "/api/forest/ws/memory?ticketKey=TB-108",
      { method: "GET", headers: {} },
    );
    expect(client.json).toHaveBeenNthCalledWith(
      2,
      "/api/forest/ws/memory?queueItemId=d-tb113-mem-1311",
      { method: "GET", headers: {} },
    );
  });

  it("refuses memory with none or two of the keys and calls nothing", async () => {
    const { tool, client } = setup();

    const none = await tool("forest_get_card_memory").handler({
      workspaceId: "ws",
    });
    const two = await tool("forest_get_card_memory").handler({
      workspaceId: "ws",
      taskId: "t1",
      ticketKey: "TB-108",
    });

    expect(none.isError).toBe(true);
    expect(two.isError).toBe(true);
    expect(client.json).not.toHaveBeenCalled();
  });
});
