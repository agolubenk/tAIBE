import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthService } from "./auth/auth-service.js";
import { harnessSlug, withAgentIdentity } from "./kaneo/agent-identity.js";
import {
  CallJournal,
  JOURNAL_PATH,
  type SendCalls,
} from "./kaneo/call-journal.js";
import { KaneoClient } from "./kaneo/client.js";
import { registerTools } from "./tools/register.js";
import { normalizeBaseUrl } from "./utils/normalize-base-url.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as {
  version: string;
};

export function createMcpServer(): McpServer {
  return createStdioServer().server;
}

// TB-135: a batch goes out with the key of the session that made its calls,
// so the API journals them under that session's agent.
function sendCalls(client: KaneoClient): SendCalls {
  return (identity, calls) => {
    const post = () =>
      client
        .json(JOURNAL_PATH, {
          method: "POST",
          body: JSON.stringify({ calls }),
        })
        .then(() => undefined);
    return identity ? withAgentIdentity(identity, post) : post();
  };
}

// The server and the journal of its calls; close() sends what the journal
// still holds. KANEO_MCP_JOURNAL=off keeps the calls out of the journal.
export function createStdioServer(): {
  server: McpServer;
  close: () => Promise<void>;
} {
  const baseUrl = normalizeBaseUrl(
    process.env.KANEO_API_URL || "http://localhost:1337",
  );
  const clientId = process.env.KANEO_MCP_CLIENT_ID || "kaneo-mcp";
  const apiKey = process.env.KANEO_API_KEY || undefined;
  const auth = new AuthService({ baseUrl, clientId, apiKey });
  // R-010: each session works under its own agent unless turned off.
  const agentSessions = process.env.KANEO_MCP_AGENT_SESSIONS !== "off";
  const client = new KaneoClient({ baseUrl, auth, agentSessions });
  const server = new McpServer({
    name: "tai-boards-mcp",
    version: packageVersion,
  });
  const defaultHarness = () =>
    harnessSlug(process.env.KANEO_MCP_HARNESS) ??
    harnessSlug(server.server.getClientVersion()?.name) ??
    "mcp";
  const journal =
    process.env.KANEO_MCP_JOURNAL === "off"
      ? undefined
      : new CallJournal(sendCalls(client));
  registerTools(server, {
    client,
    ...(journal ? { onCall: journal.record } : {}),
    ...(agentSessions ? { agentIdentity: { defaultHarness } } : {}),
  });
  return { server, close: () => journal?.close() ?? Promise.resolve() };
}
