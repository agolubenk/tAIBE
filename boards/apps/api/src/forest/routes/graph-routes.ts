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
import { listGraph } from "../graph/list-graph";
import { graphSchema } from "./graph-schema";
import { pageQuery, workspaceParam } from "./schema";

const getGraphRoute = createRoute({
  method: "get",
  operationId: "getForestGraph",
  path: "/{workspaceId}/graph",
  tags: ["Forest"],
  summary: "Get the links graph",
  description:
    "Cards you may open, newest first, with the files they touched, the decisions (D-records, ADRs) they cite, their links and their sectors. A page holds at most `take` nodes (100 by default); a file or decision shared with an earlier page comes again. Every link comes once, on the page of its newer card; links to cards of projects you may not open are left out.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: pageQuery },
  responses: {
    200: jsonResponse("A page of the links graph", graphSchema),
    400: errorResponse("Invalid cursor"),
    403: errorResponse("Missing task:read permission"),
  },
});

export const graphRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>().openapi(getGraphRoute, async (c) => {
  const { workspaceId } = c.req.valid("param");
  const { cursor, take } = c.req.valid("query");
  return c.json(
    maskForTokenCaller(
      c,
      await listGraph({ workspaceId, userId: c.get("userId"), cursor, take }),
      ["nextCursor"],
    ),
    200,
  );
});
