import { resolveForestActor } from "../forest/actor";
import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { recordCalls } from "./record-calls";
import { MAX_CALLS, mcpCallsBody, mcpCallsResult } from "./schema";

const recordMcpCallsRoute = createRoute({
  method: "post",
  operationId: "recordMcpCalls",
  path: "/mcp-calls",
  tags: ["Agents"],
  summary: "Journal MCP calls made by a local MCP server",
  description: `A stdio MCP server sends the calls it served, in batches of up to ${MAX_CALLS}, so they count in a card's spend like calls to the remote /mcp (R-036, TB-135). Each row goes under the actor of the sending key — the session's agent when it has one; the x-t-boards-session label never changes whose key it is. A call that names a card the actor cannot open is filed under the tool. A one-workspace key is refused (R-002): the rows belong to no workspace.`,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: mcpCallsBody } },
    },
  },
  responses: {
    200: jsonResponse("The calls are journaled", mcpCallsResult),
    400: errorResponse(`Not a batch of 1 to ${MAX_CALLS} calls`),
  },
});

const agentJournal = apiRouter().openapi(recordMcpCallsRoute, async (c) => {
  const { calls } = c.req.valid("json");
  return c.json(await recordCalls(resolveForestActor(c), calls), 200);
});

export default agentJournal;
