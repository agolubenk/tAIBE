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
import { resolveForestActor } from "../actor";
import { readAgentHeaders } from "../agent-guard/agent-headers";
import { listCardHistory } from "../history/card-history";
import { rollbackCard } from "../history/rollback-card";
import { assertTaskInWorkspace } from "../task-scope";
import { cardParam } from "./card-schema";
import {
  historyEntryParam,
  historyQuery,
  historySchema,
  rollbackSchema,
} from "./history-schema";

const HISTORY_DEFAULT = 50;

const getHistoryRoute = createRoute({
  method: "get",
  operationId: "getForestCardHistory",
  path: "/{workspaceId}/cards/{taskId}/history",
  tags: ["Forest"],
  summary: "List a card's edits, newest first",
  description:
    "Every change of the card's content and fields, written by database triggers, so no edit path skips it.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam, query: historyQuery },
  responses: {
    200: jsonResponse("The card's edits", historySchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

const rollbackRoute = createRoute({
  method: "post",
  operationId: "rollbackForestCardEdit",
  path: "/{workspaceId}/cards/{taskId}/history/{historyId}/rollback",
  tags: ["Forest"],
  summary: "Undo one edit of a card",
  description:
    "Puts back the values the edit replaced. Refused when a later edit changed one of those fields (undo that one first), and for agents: a rollback is a person's action. The usual rules hold: half-baked only from the owner's session, Notion fields of a mirrored card stay read-only.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: { params: historyEntryParam },
  responses: {
    200: jsonResponse("What the rollback restored", rollbackSchema),
    400: errorResponse("The recorded status no longer exists in the project"),
    403: errorResponse(
      "Missing task:update permission, an agent, or fields this person cannot change",
    ),
    404: errorResponse("Task or history entry not found"),
    409: errorResponse("A later edit changed the same fields"),
  },
});

export const historyRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>()
  .openapi(getHistoryRoute, async (c) => {
    const { workspaceId, taskId } = c.req.valid("param");
    const { take } = c.req.valid("query");
    await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    const entries = await listCardHistory(taskId, take ?? HISTORY_DEFAULT);
    // TB-144: the changes keep old titles and descriptions; a caller with a
    // token reads them masked, as it reads the task (TB-143).
    return c.json(maskForTokenCaller(c, { entries }), 200);
  })
  .openapi(rollbackRoute, async (c) => {
    const { workspaceId, taskId, historyId } = c.req.valid("param");
    await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    const result = await rollbackCard({
      workspaceId,
      taskId,
      historyId,
      actor: resolveForestActor(c),
      headers: readAgentHeaders(c),
    });
    return c.json(result, 200);
  });
