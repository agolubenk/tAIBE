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
import { listBoardBugs } from "../bugs/list-board-bugs";
import { bugsQuery, bugsSchema } from "./bugs-schema";
import { workspaceParam } from "./schema";

const listBugsRoute = createRoute({
  method: "get",
  operationId: "listForestBoardBugs",
  path: "/{workspaceId}/bugs",
  tags: ["Forest"],
  summary: "List the bugs on a project's board",
  description:
    "For the board: the cards of kind bug, with their severity. A bug is a card in the project's own columns, not a project of its own; a project you may not open answers an empty list.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: bugsQuery },
  responses: {
    200: jsonResponse("The bugs on the board", bugsSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

export const bugsRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(listBugsRoute, async (c) => {
  const { workspaceId } = c.req.valid("param");
  const { projectId } = c.req.valid("query");
  return c.json(
    maskForTokenCaller(
      c,
      await listBoardBugs(workspaceId, projectId, c.get("userId")),
    ),
    200,
  );
});
