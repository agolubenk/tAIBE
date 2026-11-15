import { describe, expect, it, vi } from "vite-plus/test";
import { decodeWire } from "../../view/wire-format.js";
import { registerTools } from "../register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup(answer: unknown = { taskId: "t1" }) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => {
      tools.set(name, handler);
    }),
  };
  const client = { json: vi.fn().mockResolvedValue(answer) };
  registerTools(server as never, { client: client as never });
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool(args);
  };
  return { client, call };
}

describe("forest card tools", () => {
  it("writes card fields with PUT under the lease headers, not in the body", async () => {
    const { client, call } = setup();

    const result = await call("forest_set_card_meta", {
      workspaceId: "ws1",
      taskId: "t 1",
      session: "dev-1",
      fencingToken: 3,
      branch: "fix/x",
      files: ["a.ts:10"],
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith(
      "/api/forest/ws1/cards/t%201/meta",
      {
        method: "PUT",
        headers: { "x-t-boards-session": "dev-1", "x-t-boards-fence": "3" },
        body: JSON.stringify({ branch: "fix/x", files: ["a.ts:10"] }),
      },
    );
  });

  it("leaves half-baked to the owner: the tool has no such field", async () => {
    const { client, call } = setup();

    const result = await call("forest_set_card_meta", {
      workspaceId: "ws1",
      taskId: "t1",
      halfBaked: false,
    });

    expect(client.json).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("reads card fields through the view, keyed by the task id", async () => {
    const { client, call } = setup({
      taskId: "t1",
      halfBaked: true,
      report: "long",
    });

    const result = await call("forest_get_card_meta", {
      workspaceId: "ws1",
      taskId: "t1",
      fields: ["halfBaked"],
    });

    expect(client.json).toHaveBeenCalledWith("/api/forest/ws1/cards/t1/meta", {
      method: "GET",
      headers: {},
    });
    expect(
      (decodeWire(result.content[0]?.text ?? "") as { data: unknown }).data,
    ).toEqual({ id: "t1", halfBaked: true });
  });

  it("reads the context pack and keeps only what changed after since", async () => {
    const { client, call } = setup({
      id: "t1",
      title: "Card",
      comments: [
        { id: "c1", content: "old", createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "c2", content: "new", createdAt: "2026-10-20T00:00:00.000Z" },
      ],
      truncated: [],
    });

    const result = await call("forest_get_context", {
      workspaceId: "ws1",
      taskId: "t1",
      since: "2026-10-10T00:00:00.000Z",
    });

    expect(client.json).toHaveBeenCalledWith(
      "/api/forest/ws1/cards/t1/context",
      { method: "GET", headers: {} },
    );
    const { data } = decodeWire(result.content[0]?.text ?? "") as {
      data: { comments: Array<{ id: string }> };
    };
    expect(data.comments.map((comment) => comment.id)).toEqual(["c2"]);
  });

  // TB-192: the memory route masks the titles for a caller with a token
  // (maskForTokenCaller). The tool reads only that route and passes its
  // answer on, so no unmasked copy reaches the agent another way.
  it("returns the card memory as the API masked it, from the one route", async () => {
    const answer = {
      available: true,
      stale: false,
      fetchedAt: "2026-11-15T00:00:00.000Z",
      scanned: 1,
      items: [
        {
          id: 7,
          type: "change",
          title: "t1: rotated [REDACTED:api_key]",
          subtitle: null,
          createdAt: "2026-11-15T00:00:00.000Z",
          matchedOn: "task-id",
          matchedValue: "t1",
          source: "text",
        },
      ],
    };
    const { client, call } = setup(answer);

    const result = await call("forest_get_card_memory", {
      workspaceId: "ws1",
      taskId: "t1",
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledTimes(1);
    expect(client.json).toHaveBeenCalledWith(
      "/api/forest/ws1/cards/t1/memory",
      {
        method: "GET",
        headers: {},
      },
    );
    expect(decodeWire(result.content[0]?.text ?? "")).toMatchObject({
      data: answer,
    });
  });
});
