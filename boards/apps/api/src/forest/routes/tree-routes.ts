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
import { assertTaskInWorkspace } from "../task-scope";
import { getCardPlace } from "../tree/card-place";
import { getTreeBranches } from "../tree/get-tree";
import { listLiveLeases } from "../tree/list-leases";
import { listTrees } from "../tree/list-trees";
import { cardParam } from "./card-schema";
import { workspaceParam } from "./schema";
import {
  cardPlaceSchema,
  leasesSchema,
  treeBranchesSchema,
  treeParam,
  treesQuery,
  treesSchema,
} from "./tree-schema";

const listTreesRoute = createRoute({
  method: "get",
  operationId: "listForestTrees",
  path: "/{workspaceId}/trees",
  tags: ["Forest"],
  summary: "List trees",
  description:
    "Root tasks (no parent subtask link), newest first, with how many branches each has, its live lease and its active sectors.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: treesQuery },
  responses: {
    200: jsonResponse("Trees", treesSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

const getTreeRoute = createRoute({
  method: "get",
  operationId: "getForestTree",
  path: "/{workspaceId}/trees/{rootId}",
  tags: ["Forest"],
  summary: "Get a tree's branches",
  description:
    "The root and its subtasks at any depth, each with its parent, in projects the caller can see.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: treeParam },
  responses: {
    200: jsonResponse("The tree", treeBranchesSchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

const listLeasesRoute = createRoute({
  method: "get",
  operationId: "listForestLeases",
  path: "/{workspaceId}/leases",
  tags: ["Forest"],
  summary: "List live leases",
  description:
    "Who works on which card right now, soonest to expire first. Fencing tokens are not shown.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Live leases", leasesSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

const getCardPlaceRoute = createRoute({
  method: "get",
  operationId: "getForestCardPlace",
  path: "/{workspaceId}/cards/{taskId}/place",
  tags: ["Forest"],
  summary: "Get where a card sits in the forest",
  description:
    "The parents up to the card's tree root, how many subcards it and the whole tree have and how many are done, and the active sectors of the tree. Parents in projects the caller cannot see are only counted.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's place", cardPlaceSchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

export const treeRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listTreesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { projectId } = c.req.valid("query");
    return c.json(
      maskForTokenCaller(
        c,
        await listTrees(workspaceId, c.get("userId"), projectId),
      ),
      200,
    );
  })
  .openapi(getTreeRoute, async (c) => {
    const { workspaceId, rootId } = c.req.valid("param");
    const userId = c.get("userId");
    await assertTaskInWorkspace(rootId, workspaceId, userId);
    return c.json(
      maskForTokenCaller(c, await getTreeBranches(rootId, workspaceId, userId)),
      200,
    );
  })
  .openapi(getCardPlaceRoute, async (c) => {
    const { workspaceId, taskId } = c.req.valid("param");
    const userId = c.get("userId");
    await assertTaskInWorkspace(taskId, workspaceId, userId);
    return c.json(
      maskForTokenCaller(c, await getCardPlace(taskId, workspaceId, userId)),
      200,
    );
  })
  .openapi(listLeasesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      maskForTokenCaller(c, await listLiveLeases(workspaceId, c.get("userId"))),
      200,
    );
  });
