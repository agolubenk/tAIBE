import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { isTokenCaller } from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { buildCardContext } from "../context/card-context";
import { assertTaskInWorkspace } from "../task-scope";
import { cardParam } from "./card-schema";
import { cardContextSchema } from "./context-schema";

const getContextRoute = createRoute({
  method: "get",
  operationId: "getForestCardContext",
  path: "/{workspaceId}/cards/{taskId}/context",
  tags: ["Forest"],
  summary: "Get the context pack of a card",
  description:
    "The task with its labels and card fields, the live lease, pending approval requests, linked cards, the latest comments and which fields the latest edits changed. Each list is capped; `truncated` names the ones that had more. A caller with a token (API key, agent key, MCP) reads secrets in free text as [REDACTED:<kind>]; names, ids and dates pass as they are. The web app's session reads the text as stored.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's context pack", cardContextSchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

export const contextRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(getContextRoute, async (c) => {
  const { workspaceId, taskId } = c.req.valid("param");
  const userId = c.get("userId");
  await assertTaskInWorkspace(taskId, workspaceId, userId);
  return c.json(
    await buildCardContext(taskId, workspaceId, userId, {
      tokenCaller: isTokenCaller(c),
    }),
    200,
  );
});
