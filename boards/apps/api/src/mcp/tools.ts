import {
  createRegisterTool,
  registerTools,
  type ToolCall,
  type ToolRegistrar,
} from "@kaneo/mcp/tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { ForestActor } from "../forest/actor";
import { writeJournal } from "../forest/journal";
import { callDetail, callTarget } from "./call-detail";
import type { McpRole } from "./tool-scope/roles";
import { collectTools, registerScoped } from "./tool-scope/scoped-tools";
import {
  grantSessionKey,
  grantTools,
  listGrants,
} from "./tool-scope/tool-grants";

export type McpToolRegistrar = ToolRegistrar;

type ShapeToolServer = {
  registerTool(
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    callback: (args: unknown) => Promise<CallToolResult>,
  ): unknown;
};

export function toMcpToolRegistrar(server: ShapeToolServer): McpToolRegistrar {
  return {
    registerTool: (name, config, callback) =>
      server.registerTool(
        name,
        {
          description: config.description,
          inputSchema: config.inputSchema.shape,
        },
        (args) => callback(args),
      ),
  };
}

class ApiClient {
  readonly usingApiKey = false;
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const detail =
        typeof body === "object" && body !== null && "message" in body
          ? (body as { message: string }).message
          : typeof body === "string" && body.length > 0
            ? body.slice(0, 500)
            : `HTTP ${res.status}`;
      throw new Error(`${path}: ${detail}`);
    }
    return body as T;
  }
}

// role: R-034, the tool set this session sees; none keeps the full set.
// label: the client's session label (x-t-boards-session), TB-135.
export type McpSession = {
  token: string;
  userId: string;
  role?: McpRole;
  label?: string;
};

// MCP rows go under the same actor the forest gives this bearer and label
// (resolveForestActor): the label names the session, the token the user.
export function bearerActor(userId: string, label?: string): ForestActor {
  const base = `bearer:${userId}`;
  return label
    ? { kind: "agent", id: `${base}:${label}`, name: label, userId }
    : { kind: "agent", id: base, name: base, userId };
}

// AC-022: a TOON codec failure answers in JSON and lands in the agent journal.
function journalFormatFallback(actor: ForestActor) {
  return (tool: string, error: string) => {
    writeJournal({
      workspaceId: null,
      actor,
      action: "mcp.format_fallback",
      targetType: "mcp_tool",
      targetId: tool,
      outcome: "allowed",
      detail: error,
    }).catch((e: unknown) =>
      console.error("t-boards: format fallback not journaled", e),
    );
  };
}

// R-036: every call, with its arguments and answer size. The workspace stays
// empty: the agent names it in the arguments, and a wrong one must not lose
// the row on the foreign key. A call about a card is filed under it (TB-44).
function journalCall(actor: ForestActor) {
  return (call: ToolCall) => {
    writeJournal({
      workspaceId: null,
      actor,
      action: "mcp.call",
      ...callTarget(call),
      outcome: call.ok ? "allowed" : "denied",
      detail: callDetail(call),
    }).catch((e: unknown) =>
      console.error("t-boards: MCP call not journaled", e),
    );
  };
}

export async function registerMcpTools(
  server: McpToolRegistrar,
  baseUrl: string,
  session: McpSession,
): Promise<void> {
  const client = new ApiClient(baseUrl, session.token);
  const actor = bearerActor(session.userId, session.label);
  const hooks = {
    onFormatFallback: journalFormatFallback(actor),
    onCall: journalCall(actor),
  };
  const { role } = session;
  if (!role) {
    registerTools(server, { client, ...hooks });
    return;
  }
  const catalog = collectTools((registrar) =>
    registerTools(registrar, { client, ...hooks }),
  );
  const key = grantSessionKey(role, session.token);
  registerScoped(server, createRegisterTool(server, client, hooks), catalog, {
    role,
    granted: await listGrants(key),
    grant: (tools) => grantTools(key, tools),
  });
}
