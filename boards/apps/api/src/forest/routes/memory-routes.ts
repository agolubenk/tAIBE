import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { maskForTokenCaller } from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { loadCardBinding } from "../memory/card-binding";
import { findCardMemory } from "../memory/find-card-memory";
import { getMemoryReader, memoryProject } from "../memory/memory-reader";
import { assertTaskInWorkspace } from "../task-scope";
import { cardParam } from "./card-schema";
import { cardMemorySchema } from "./memory-schema";

const getMemoryRoute = createRoute({
  method: "get",
  operationId: "getForestCardMemory",
  path: "/{workspaceId}/cards/{taskId}/memory",
  tags: ["Forest"],
  summary: "List claude-mem observations about a card",
  description:
    "Observations among the claude-mem worker's latest ones that name the card's id, Backlog ID, board number or branch. Read-only; when the worker is down the last copy is returned and marked stale. A caller with a token (API key, agent key, MCP) reads secrets in the titles as [REDACTED:<kind>]; the web app's session reads them as stored.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's observations", cardMemorySchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

export const memoryRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(getMemoryRoute, async (c) => {
  const { workspaceId, taskId } = c.req.valid("param");
  await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
  const memory = await findCardMemory(
    getMemoryReader(),
    await loadCardBinding(taskId),
    { project: memoryProject() },
  );
  // TB-192: titles come from the claude-mem summarizer and can hold a secret.
  // A token caller feeds a model and reads them masked; the web app does not
  // (TB-143 decision (a)). Read-only, so nothing is restored on write.
  return c.json(maskForTokenCaller(c, memory), 200);
});
