import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import getTaskByTicketId from "../../task/controllers/get-task-by-ticket-id";
import { requestWorkspaceScope } from "../../utils/api-key-workspace-scope";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import {
  labelBySource,
  loadCardMemoryKeys,
  type MemoryKey,
} from "../memory/card-memory-keys";
import { getCardMemoryFinder } from "../memory/memory-reader";
import { assertQueueItemVisible } from "../memory/queue-item-check";
import { assertTaskInWorkspace } from "../task-scope";
import { cardParam } from "./card-schema";
import {
  cardMemorySchema,
  memoryLookupParam,
  memoryLookupQuery,
} from "./memory-schema";

const getMemoryRoute = createRoute({
  method: "get",
  operationId: "getForestCardMemory",
  path: "/{workspaceId}/cards/{taskId}/memory",
  tags: ["Forest"],
  summary: "List claude-mem observations about a card",
  description:
    "For each of the card's keys — its id, board key, Backlog ID and the owner-queue items of its «да» requests, up to 6 — how many claude-mem observations name it exactly and the 5 newest titles. Read-only, through the Mac memory proxy; when the proxy is down the last answer is returned, marked stale, for up to 24 hours.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ],
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's observations", cardMemorySchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

const lookupMemoryRoute = createRoute({
  method: "get",
  operationId: "lookupForestMemory",
  path: "/{workspaceId}/memory",
  tags: ["Forest"],
  summary: "List claude-mem observations by card key or owner-queue item",
  description:
    "The same answer as a card's memory, found by exactly one of ticketKey (a card of this workspace, e.g. TB-108: its card memory) or queueItemId (an owner-queue item the t-boards token sees: observations that name it). Any other word cannot be searched.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ],
  request: { params: memoryLookupParam, query: memoryLookupQuery },
  responses: {
    200: jsonResponse("The observations", cardMemorySchema),
    400: errorResponse("Neither or both of ticketKey and queueItemId"),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("No such card in this workspace or no such queue item"),
    503: errorResponse("The owner queue is not linked or did not answer"),
  },
});

async function searchMemory(keys: MemoryKey[]) {
  const memory = await getCardMemoryFinder()(keys.map(({ key }) => key));
  return labelBySource(memory, keys);
}

export const memoryRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(getMemoryRoute, async (c) => {
    const { workspaceId, taskId } = c.req.valid("param");
    await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    return c.json(await searchMemory(await loadCardMemoryKeys(taskId)), 200);
  })
  .openapi(lookupMemoryRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { ticketKey, queueItemId } = c.req.valid("query");
    if (Boolean(ticketKey) === Boolean(queueItemId)) {
      throw new HTTPException(400, {
        message: "Give exactly one of ticketKey and queueItemId",
      });
    }
    if (queueItemId) {
      await assertQueueItemVisible(workspaceId, queueItemId);
      return c.json(
        await searchMemory([{ key: queueItemId, source: "queue" }]),
        200,
      );
    }
    const userId = c.get("userId");
    const task = await getTaskByTicketId(ticketKey as string, userId, {
      workspaceId,
      apiKeyScope: requestWorkspaceScope(c),
    });
    await assertTaskInWorkspace(task.id, workspaceId, userId);
    return c.json(await searchMemory(await loadCardMemoryKeys(task.id)), 200);
  });
