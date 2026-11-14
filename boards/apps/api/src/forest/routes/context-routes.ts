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
    "The task with its labels and card fields, the live lease, pending approval requests, linked cards, the latest comments and which fields the latest edits changed. Each list is capped; `truncated` names the ones that had more.",
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
  const { meta, lease, approvals, ...card } = await buildCardContext(
    taskId,
    workspaceId,
    userId,
  );
  // TB-144: the task text, labels, linked card titles and comments reach a
  // caller with a token masked, as on the task and comment routes (TB-143).
  // Forest working data stays as its own routes return it: a masked copy of
  // meta would come back through set_card_meta, which restores nothing.
  return c.json(
    { ...maskForTokenCaller(c, card), meta, lease, approvals },
    200,
  );
});
