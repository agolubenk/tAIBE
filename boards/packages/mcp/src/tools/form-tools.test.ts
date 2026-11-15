import { describe, expect, it, vi } from "vite-plus/test";
import { registerTools } from "./register.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup(answer: unknown = { id: "f1" }) {
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

const TEMPLATE = {
  form: "release-check",
  version: 1,
  title: "Release check",
  fields: [
    { id: "ready", type: "yesno", q: "Ready?" },
    { id: "risk", type: "choice", q: "Risk", options: ["low", "high"] },
  ],
};

describe("form tools (TB-173)", () => {
  it("creates a template with the type keys the API checks", async () => {
    const { client, call } = setup();

    const result = await call("create_form", {
      workspaceId: "ws 1",
      template: TEMPLATE,
    });

    expect(result.isError).toBe(false);
    // `options` is not in the tool's own schema: it goes to the API as sent.
    expect(client.json).toHaveBeenCalledWith("/api/form/template/ws%201", {
      method: "POST",
      body: JSON.stringify({ template: TEMPLATE }),
    });
  });

  it("refuses an unknown field type before the API", async () => {
    const { client, call } = setup();

    const result = await call("create_form", {
      workspaceId: "ws1",
      template: { ...TEMPLATE, fields: [{ id: "a", type: "slider", q: "?" }] },
    });

    expect(result.isError).toBe(true);
    expect(client.json).not.toHaveBeenCalled();
  });

  it("attaches a form under the lease headers, not in the body", async () => {
    const { client, call } = setup();

    const result = await call("attach_form", {
      taskId: "t1",
      templateId: "tpl1",
      session: "plan-1",
      fencingToken: 7,
    });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith("/api/form/task/t1", {
      method: "POST",
      headers: { "x-t-boards-session": "plan-1", "x-t-boards-fence": "7" },
      body: JSON.stringify({ templateId: "tpl1" }),
    });
  });

  it("reads the forms of a card", async () => {
    const { client, call } = setup({ forms: [] });

    const result = await call("get_form_responses", { taskId: "t1" });

    expect(result.isError).toBe(false);
    expect(client.json).toHaveBeenCalledWith("/api/form/task/t1");
  });
});
