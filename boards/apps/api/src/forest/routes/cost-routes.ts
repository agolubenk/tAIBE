import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { cardCost } from "../read/card-cost";
import { assertTaskInWorkspace } from "../task-scope";
import { cardParam } from "./card-schema";
import { cardCostSchema } from "./cost-schema";

const getCostRoute = createRoute({
  method: "get",
  operationId: "getForestCardCost",
  path: "/{workspaceId}/cards/{taskId}/cost",
  tags: ["Forest"],
  summary: "Get a card's MCP spend",
  description:
    "Answered MCP calls about the card and the tokens of their answers, per caller, from the journal (R-036). Calls journaled before TB-44 and calls by ticket ID are not counted. The card's own tokens and costUsd come alongside.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's spend", cardCostSchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

export const costRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(getCostRoute, async (c) => {
  const { workspaceId, taskId } = c.req.valid("param");
  await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
  return c.json(await cardCost(taskId), 200);
});
