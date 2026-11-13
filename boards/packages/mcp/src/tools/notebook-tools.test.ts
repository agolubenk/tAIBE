import { describe, expect, it, vi } from "vite-plus/test";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup(answer: unknown) {
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
  const client = { json: vi.fn().mockResolvedValue(answer) };
  registerTools(server as never, { client: client as never });
  const tool = tools.get("notebook_search");
  if (!tool) throw new Error("notebook_search is not registered");
  return { tool, client };
}

const hits = {
  mode: "keyword",
  results: [
    {
      chunkId: "c1",
      source: { kind: "card", ref: "t1", title: "AIB-12 Блокнот в UI" },
      heading: "AIB-12 Блокнот в UI",
      text: "Страница с чатом.",
      score: 0.016,
      matchedBy: ["keyword"],
    },
  ],
};

describe("notebook_search", () => {
  it("posts the query to the workspace notebook and returns the hits", async () => {
    const { tool, client } = setup(hits);

    const result = await tool.handler({
      workspaceId: "ws 1",
      query: "блокнот",
      limit: 3,
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith("/api/notebook/ws%201/search", {
      method: "POST",
      body: JSON.stringify({ query: "блокнот", limit: 3 }),
    });
    expect(result.content[0]?.text).toContain("Страница с чатом.");
  });

  it("rejects an empty query and an oversized limit", () => {
    const { tool } = setup(hits);

    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "  " }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "q", limit: 21 })
        .success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({ workspaceId: "ws", query: "q", mode: "keyword" })
        .success,
    ).toBe(true);
  });
});

function setupTool(name: string, ...answers: unknown[]) {
  const tools = new Map<string, { schema: never; handler: Handler }>();
  const server = {
    registerTool: vi.fn(
      (n: string, config: { inputSchema: never }, handler: Handler) => {
        tools.set(n, { schema: config.inputSchema, handler });
      },
    ),
  };
  const json = vi.fn();
  for (const answer of answers) json.mockResolvedValueOnce(answer);
  registerTools(server as never, { client: { json } as never });
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  return { tool, json };
}

const thread = (status: string | null, content: string, extra = 0) => ({
  thread: { id: "th1", title: "q", createdAt: "x", updatedAt: "x" },
  messages: [
    { role: "user", content: "q", status: null, citations: [], model: null },
    {
      role: "assistant",
      content,
      status,
      model: "glm-4.7",
      citations: Array.from({ length: 2 + extra }, (_, i) => ({
        n: i + 1,
        chunkId: `c${i}`,
        kind: "repo-doc",
        ref: `docs/a${i}.md`,
        title: `A${i}`,
        heading: "h",
      })),
    },
  ],
});

describe("notebook_ask", () => {
  it("starts a thread and returns the answer with short citations", async () => {
    const { tool, json } = setupTool(
      "notebook_ask",
      thread("answered", "Ответ без номеров ссылок.", 6),
    );

    const result = await tool.handler({
      workspaceId: "ws_1",
      question: "Как?",
    });
    const body = JSON.parse(result.content[0]?.text ?? "{}");

    expect(result.isError).toBe(false);
    expect(json).toHaveBeenCalledWith("/api/notebook/ws_1/threads", {
      method: "POST",
      body: JSON.stringify({ question: "Как?" }),
    });
    expect(body).toMatchObject({ threadId: "th1", status: "answered" });
    expect(body.citations).toHaveLength(5);
    expect(body.citations[0]).toEqual({
      n: 1,
      kind: "repo-doc",
      ref: "docs/a0.md",
      title: "A0",
    });
  });

  it("asks a follow-up in the given thread and cuts a long answer", async () => {
    const { tool, json } = setupTool(
      "notebook_ask",
      thread("answered", "x".repeat(500)),
    );

    const result = await tool.handler({
      workspaceId: "ws",
      question: "А дальше?",
      threadId: "th1",
      maxAnswerChars: 200,
    });
    const body = JSON.parse(result.content[0]?.text ?? "{}");

    expect(json).toHaveBeenCalledWith("/api/notebook/ws/threads/th1/messages", {
      method: "POST",
      body: JSON.stringify({ question: "А дальше?" }),
    });
    expect(body.answer.startsWith("x".repeat(200))).toBe(true);
    expect(body.answer).toContain("cut at 200");
  });

  it.each(["capped", "rate-limited", "failed", "retrieval-only"])(
    "reports %s as an error, not as an empty answer",
    async (status) => {
      const { tool } = setupTool("notebook_ask", thread(status, ""));

      const result = await tool.handler({ workspaceId: "ws", question: "q" });
      const body = JSON.parse(result.content[0]?.text ?? "{}");

      expect(result.isError).toBe(true);
      expect(body.status).toBe(status);
      expect(body.error).toContain("notebook_search");
      expect(body.citations).toHaveLength(2);
    },
  );

  it("is not a read tool: no R-031 view, no fullRef re-run", async () => {
    const { isReadTool } = await import("./register-tool.js");
    expect(isReadTool("notebook_ask")).toBe(false);
    expect(isReadTool("notebook_brief")).toBe(false);
    expect(isReadTool("notebook_add_source")).toBe(false);
  });
});

describe("notebook_brief", () => {
  it("returns the stored brief without a new model call", async () => {
    const { tool, json } = setupTool(
      "notebook_brief",
      thread("brief", "GOAL: …"),
    );

    const result = await tool.handler({ workspaceId: "ws", threadId: "th1" });

    expect(result.isError).toBe(false);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith("/api/notebook/ws/threads/th1", {
      method: "GET",
    });
  });

  it("writes a brief when the thread has none, and with force", async () => {
    const fresh = setupTool(
      "notebook_brief",
      thread("answered", "Ответ"),
      thread("brief", "GOAL: …"),
    );
    const made = await fresh.tool.handler({
      workspaceId: "ws",
      threadId: "th1",
    });
    expect(made.isError).toBe(false);
    expect(fresh.json.mock.calls[1]?.[0]).toBe(
      "/api/notebook/ws/threads/th1/brief",
    );

    const forced = setupTool("notebook_brief", thread("brief", "GOAL: new"));
    await forced.tool.handler({
      workspaceId: "ws",
      threadId: "th1",
      force: true,
    });
    expect(forced.json).toHaveBeenCalledTimes(1);
    expect(forced.json.mock.calls[0]?.[0]).toBe(
      "/api/notebook/ws/threads/th1/brief",
    );
  });

  it("reports brief-failed as an error", async () => {
    const { tool } = setupTool("notebook_brief", thread("brief-failed", ""));

    const result = await tool.handler({
      workspaceId: "ws",
      threadId: "th1",
      force: true,
    });

    expect(result.isError).toBe(true);
  });
});

describe("notebook_add_source", () => {
  it.each([
    ["https://github.com/agolubenk/tAIBE/pull/170", "github-pr"],
    ["agolubenk/tAIBE#170", "github-pr"],
    ["https://opencode.ai/docs/agents", "link"],
    ["https://github.com/agolubenk/tAIBE/blob/main/README.md", "link"],
  ])("posts %s to the %s route", async (url, kind) => {
    const { tool, json } = setupTool("notebook_add_source", {
      sourceId: "s1",
      kind,
      ref: url,
      title: "t",
      changed: true,
    });

    const result = await tool.handler({ workspaceId: "ws", url });

    expect(result.isError).toBe(false);
    expect(json).toHaveBeenCalledWith(`/api/notebook/ws/sources/${kind}`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  });

  it("passes the API refusal through as an error", async () => {
    const { tool, json } = setupTool("notebook_add_source");
    json.mockRejectedValueOnce(new Error("HTTP 422 LINK_PRIVATE_DESTINATION"));

    const result = await tool.handler({
      workspaceId: "ws",
      url: "https://10.0.0.1/x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("LINK_PRIVATE_DESTINATION");
  });
});

describe("notebook review fixes (opencode lenses on #170)", () => {
  it("keeps every source the answer cites, beyond the first five", async () => {
    const answer = thread("answered", "Да [1], и ещё [7].", 6);
    const { tool } = setupTool("notebook_ask", answer);

    const result = await tool.handler({ workspaceId: "ws", question: "q" });
    const body = JSON.parse(result.content[0]?.text ?? "{}");

    expect(body.citations.map((c: { n: number }) => c.n)).toEqual([1, 7]);
  });

  it("reports an answered turn with empty text as an error", async () => {
    const { tool } = setupTool("notebook_ask", thread("answered", "  "));

    const result = await tool.handler({ workspaceId: "ws", question: "q" });

    expect(result.isError).toBe(true);
  });

  it("reports a thread with no assistant turn as an error", async () => {
    const empty = { ...thread("answered", "x"), messages: [] };
    const { tool } = setupTool("notebook_ask", empty);

    const result = await tool.handler({ workspaceId: "ws", question: "q" });
    const body = JSON.parse(result.content[0]?.text ?? "{}");

    expect(result.isError).toBe(true);
    expect(body.status).toBe("no-answer-yet");
  });

  it("turns a transport failure into an error result", async () => {
    const { tool, json } = setupTool("notebook_ask");
    json.mockRejectedValueOnce(new Error("HTTP 502 bad gateway"));

    const result = await tool.handler({ workspaceId: "ws", question: "q" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("502");
    expect(result.content[0]?.text).toContain("do not repeat it blindly");
  });

  it("writes a new brief when a question came after the stored one", async () => {
    const pending = thread("brief", "GOAL: old");
    pending.messages.push({
      role: "user",
      content: "А если иначе?",
      status: null,
      model: null,
      citations: [],
    });
    const { tool, json } = setupTool(
      "notebook_brief",
      pending,
      thread("brief", "GOAL: new"),
    );

    await tool.handler({ workspaceId: "ws", threadId: "th1" });

    expect(json).toHaveBeenCalledTimes(2);
  });

  it("refuses ids that could leave /api/notebook/", () => {
    const { tool } = setupTool("notebook_ask");
    const schema = tool.schema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };

    expect(schema.safeParse({ workspaceId: "..", question: "q" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ workspaceId: "ws", question: "q", threadId: "a/b" })
        .success,
    ).toBe(false);
  });

  it("writes a new brief when an answer came after the stored one", async () => {
    const stale = thread("answered", "Новый ответ");
    stale.messages.splice(1, 0, {
      role: "assistant",
      content: "GOAL: old",
      status: "brief",
      model: "glm-4.7",
      citations: [],
    });
    const { tool, json } = setupTool(
      "notebook_brief",
      stale,
      thread("brief", "GOAL: new"),
    );

    const result = await tool.handler({ workspaceId: "ws", threadId: "th1" });
    const body = JSON.parse(result.content[0]?.text ?? "{}");

    expect(json).toHaveBeenCalledTimes(2);
    expect(json.mock.calls[1]).toEqual([
      "/api/notebook/ws/threads/th1/brief",
      { method: "POST" },
    ]);
    expect(body).toMatchObject({ status: "brief", answer: "GOAL: new" });
  });
});
