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
import { listCardWorkers } from "../workers/list-card-workers";
import { workspaceParam } from "./schema";
import { workersQuery, workersSchema } from "./workers-schema";

const listWorkersRoute = createRoute({
  method: "get",
  operationId: "listForestCardWorkers",
  path: "/{workspaceId}/workers",
  tags: ["Forest"],
  summary: "List who works on a project's cards",
  description:
    "For the board: per card, the live lease holder, the latest session whose working state names it and the recorded executor. Cards nobody is on are left out; a project you may not open answers an empty list.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: workersQuery },
  responses: {
    200: jsonResponse("Who works on the cards", workersSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

export const workersRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(listWorkersRoute, async (c) => {
  const { workspaceId } = c.req.valid("param");
  const { projectId } = c.req.valid("query");
  return c.json(
    maskForTokenCaller(
      c,
      await listCardWorkers(workspaceId, projectId, c.get("userId")),
    ),
    200,
  );
});
