import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { normalizeHarness, normalizeSession } from "./agent-naming";
import { agentKeyIssuer } from "./issuer";
import { issueAgentKey } from "./issue-agent-key";
import { listAgents } from "./list-agents";
import {
  agentEnabledSchema,
  agentListSchema,
  agentParam,
  issueAgentKeyBody,
  issuedAgentKeySchema,
  setAgentEnabledBody,
  toolSetsSchema,
} from "./schema";
import { setAgentEnabled } from "./set-agent-enabled";
import { toolSets } from "./tool-sets";

const issueAgentKeyRoute = createRoute({
  method: "post",
  operationId: "issueAgentKey",
  path: "/session",
  tags: ["Agents"],
  summary: "Issue a key for an agent session",
  description:
    "Gets or creates the agent of the caller, harness and session — a user of its own that cannot sign in — copies the caller's workspace memberships onto it (owner becomes admin) and returns a key valid for a day. Cards, comments and the journal then show the agent's name, not the caller's. An agent idle for a day is in the archive; asking again brings it back with its name and history while the caller has fewer than 50 active agents. Only a person's session or unscoped key may call it.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: issueAgentKeyBody } },
    },
  },
  responses: {
    200: jsonResponse("The agent and its new key", issuedAgentKeySchema),
    400: errorResponse("Harness or session label not accepted"),
    403: errorResponse(
      "The caller is an agent or a one-workspace key, the agent is disabled, or the caller already has 50 active agents",
    ),
  },
});

const listAgentsRoute = createRoute({
  method: "get",
  operationId: "listAgents",
  path: "/",
  tags: ["Agents"],
  summary: "List your agents",
  description:
    "Your agents with their live keys: name, harness, session, when each key was made, last used and expires. Active agents come first, then the archived ones, then the disabled ones. Key secrets are never returned.",
  responses: {
    200: jsonResponse("Your agents", agentListSchema),
    403: errorResponse("Agents and one-workspace keys do not list agents"),
  },
});

const setAgentEnabledRoute = createRoute({
  method: "patch",
  operationId: "setAgentEnabled",
  path: "/{agentId}",
  tags: ["Agents"],
  summary: "Disable or enable an agent",
  description:
    "Disabling revokes every key of the agent at once and refuses new ones; its work stays under its name. Enabling a disabled agent moves it to the archive: it takes a place among the active agents again when its session asks for a key. Enabling an active or archived agent changes nothing.",
  request: {
    params: agentParam,
    body: {
      required: true,
      content: { "application/json": { schema: setAgentEnabledBody } },
    },
  },
  responses: {
    200: jsonResponse("The agent's state", agentEnabledSchema),
    403: errorResponse("Agents and one-workspace keys do not manage agents"),
    404: errorResponse("Agent not found"),
  },
});

const toolSetsRoute = createRoute({
  method: "get",
  operationId: "listMcpToolSets",
  path: "/tool-sets",
  tags: ["Agents"],
  summary: "List the MCP tool sets",
  description:
    "The tools an MCP session of each role sees in tools/list (R-034) and the header that names the role. A role trims the list to save tokens; the API still checks every call.",
  responses: {
    200: jsonResponse("Tool sets by role", toolSetsSchema),
  },
});

// R-010: every session works under its own name, several at once if need be.
const agentIdentity = apiRouter()
  .openapi(issueAgentKeyRoute, async (c) => {
    const issuer = agentKeyIssuer(c);
    const body = c.req.valid("json");
    const harness = normalizeHarness(body.harness);
    const session = normalizeSession(body.session);
    if (!harness || !session) {
      throw new HTTPException(400, {
        message:
          "harness is a lowercase slug; session uses letters, digits, spaces and . _ : / # @ + - up to 80",
      });
    }
    const issued = await issueAgentKey(
      { ownerId: issuer.ownerId, harness, session },
      { permissions: issuer.permissions, expiresAt: issuer.expiresAt },
    );
    return c.json(issued, 200);
  })
  .openapi(listAgentsRoute, async (c) => {
    const { ownerId } = agentKeyIssuer(c);
    return c.json(await listAgents(ownerId), 200);
  })
  .openapi(setAgentEnabledRoute, async (c) => {
    const { ownerId } = agentKeyIssuer(c);
    const { agentId } = c.req.valid("param");
    const { enabled } = c.req.valid("json");
    return c.json(await setAgentEnabled(ownerId, agentId, enabled), 200);
  })
  .openapi(toolSetsRoute, (c) => c.json(toolSets(), 200));

export default agentIdentity;
