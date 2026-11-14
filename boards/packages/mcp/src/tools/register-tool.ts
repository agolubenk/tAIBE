import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type AgentIdentity,
  harnessSlug,
  withAgentIdentity,
} from "../kaneo/agent-identity.js";
import { errorResult } from "../utils/mcp-result.js";
import { shapeResult } from "../view/shape-result.js";
import { splitView, viewOptionsShape } from "../view/view-options.js";
import { defaultCounter } from "../view/wire-format.js";
import {
  agentWriteShape,
  isAgentWriteTool,
  splitAgentWrite,
  withHeaders,
} from "./agent-write.js";
import { sessionField } from "./forest/request.js";
import type { ToolClient, ToolRegistrar } from "./register.js";

// The callback gets the client for this call: for agent task writes it carries
// the lease and «да» headers taken out of the arguments.
export type RegisterTool = <S extends z.ZodObject>(
  name: string,
  config: { description: string; inputSchema: S },
  callback: (args: z.output<S>, client: ToolClient) => Promise<CallToolResult>,
) => unknown;

// Tools whose answer goes through the R-031 view (etag, filters, budget).
const READ_TOOLS = new Set([
  "whoami",
  "list_workspaces",
  "list_projects",
  "get_project",
  "list_tasks",
  "get_task",
  "get_task_by_ticket_id",
  "list_task_comments",
  "list_workspace_labels",
  "get_task_relations",
  "list_workspace_members",
  "search",
  "list_project_columns",
  "list_task_time_entries",
  "get_time_entry",
  "list_task_activity",
  "list_notifications",
  "forest_list_approvals",
  "forest_list_logs",
  "forest_get_log",
  "forest_list_sectors",
  "forest_get_card_meta",
  "forest_get_context",
  "forest_get_card_memory",
  "forest_list_work_state",
  "notebook_search",
]);

export function isReadTool(name: string) {
  return READ_TOOLS.has(name);
}

// run() keeps the API answer next to its text, so the read wrapper reshapes
// the data itself instead of parsing the text back.
const answers = new WeakMap<CallToolResult, unknown>();

export function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  return fn()
    .then((data) => {
      const result: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(data) ?? "null" }],
        isError: false,
      };
      answers.set(result, data);
      return result;
    })
    .catch((e: unknown) =>
      errorResult(e instanceof Error ? e.message : String(e)),
    );
}

// What the caller sends again, narrower, to get what a cut answer left out.
function fullRef(name: string, args: object) {
  return `${name} ${JSON.stringify(args)}`;
}

// Without a host hook a codec fallback goes to stderr: stdout is the stdio
// protocol.
export type FormatFallback = (tool: string, error: string) => void;
const logFallback: FormatFallback = (tool, error) =>
  console.error(`kaneo-mcp: ${tool} answered in JSON, TOON failed: ${error}`);

// R-036: one record per call for the host's journal. The arguments are as the
// caller sent them; the host redacts them before storing. With agent sessions
// the call names who it ran as (TB-135), so the host journals it under them.
export type ToolCall = {
  tool: string;
  args: unknown;
  ok: boolean;
  bytes: number;
  tokens: number;
  ms: number;
  identity?: AgentIdentity;
};

export type RegisterHooks = {
  onFormatFallback?: FormatFallback;
  onCall?: (call: ToolCall) => void;
  // R-010: every tool takes session and harness, and the call runs as that
  // session's own agent. Left out where the server already knows the caller.
  agentIdentity?: { defaultHarness: () => string };
};

const identityShape = {
  session: sessionField
    .optional()
    .describe(
      "Your session's stable label, the same on every call (role and number, e.g. «successor bb»). Cards, comments and the journal show your work under it; without it you work as your harness's default agent.",
    ),
  harness: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Where you run: claude-code, codex, continue, cursor, kimi, copilot, roo or your own name.",
    ),
};

function answerText(result: CallToolResult) {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export function createRegisterTool(
  server: ToolRegistrar,
  client: ToolClient,
  hooks: RegisterHooks = {},
): RegisterTool {
  const onFormatFallback = hooks.onFormatFallback ?? logFallback;
  const { onCall, agentIdentity } = hooks;
  return (name, config, callback) => {
    const read = isReadTool(name);
    const agentWrite = isAgentWriteTool(name);
    // Forest tools and agent writes already take a session; it names the
    // agent too.
    const ownSession = agentWrite || "session" in config.inputSchema.shape;
    const base = !agentIdentity
      ? config.inputSchema
      : config.inputSchema.extend(
          ownSession ? { harness: identityShape.harness } : identityShape,
        );
    const inputSchema = read
      ? base.extend(viewOptionsShape)
      : agentWrite
        ? base.extend(agentWriteShape)
        : base;
    const dispatch = async (
      data: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      if (agentWrite) {
        const { headers, rest } = splitAgentWrite(data);
        return callback(
          rest as z.output<typeof config.inputSchema>,
          withHeaders(client, headers),
        );
      }
      if (!read)
        return callback(data as z.output<typeof config.inputSchema>, client);
      const { view, rest } = splitView(data);
      const result = await callback(
        rest as z.output<typeof config.inputSchema>,
        client,
      );
      if (result.isError || !answers.has(result)) return result;
      return shapeResult(answers.get(result), view, fullRef(name, rest), (e) =>
        onFormatFallback(name, e),
      );
    };
    const handle = async (
      args: unknown,
    ): Promise<{ result: CallToolResult; identity?: AgentIdentity }> => {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) {
        return { result: errorResult(z.prettifyError(parsed.error)) };
      }
      const data = { ...(parsed.data as Record<string, unknown>) };
      if (!agentIdentity) return { result: await dispatch(data) };
      const identity: AgentIdentity = {
        harness:
          harnessSlug(data.harness as string | undefined) ??
          agentIdentity.defaultHarness(),
        session: data.session as string | undefined,
      };
      delete data.harness;
      if (!ownSession) delete data.session;
      const result = await withAgentIdentity(identity, () => dispatch(data));
      return { result, identity };
    };
    return server.registerTool(
      name,
      { ...config, inputSchema },
      async (args) => {
        if (!onCall) return (await handle(args)).result;
        const started = performance.now();
        const { result, identity } = await handle(args);
        const text = answerText(result);
        try {
          onCall({
            tool: name,
            args,
            ok: !result.isError,
            bytes: new TextEncoder().encode(text).length,
            tokens: defaultCounter.count(text),
            ms: Math.round(performance.now() - started),
            ...(identity ? { identity } : {}),
          });
        } catch (e) {
          // The journal must not turn an answered call into a failed one.
          console.error(`kaneo-mcp: ${name} call not recorded`, e);
        }
        return result;
      },
    );
  };
}
