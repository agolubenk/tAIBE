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
import { fellTrees } from "../fell/fell-trees";
import { growForest } from "../grow/grow-forest";
import {
  fellBody,
  fellResultSchema,
  growBody,
  growResultSchema,
  workspaceParam,
} from "./schema";

const fellRoute = createRoute({
  method: "post",
  operationId: "fellForest",
  path: "/{workspaceId}/fell",
  tags: ["Forest"],
  summary: "Fell a tree or a sector",
  description:
    "Copies whole trees into read-only logs and seeds, then deletes the tasks, in one transaction. Needs the owner's «да»: the owner's own session, or an approved approvalId that covers exactly these trees.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["delete"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: fellBody } },
    },
  },
  responses: {
    200: jsonResponse("What the felling produced", fellResultSchema),
    400: errorResponse("Not a root task, or trees from another workspace"),
    403: errorResponse(
      "No owner approval, missing permission or project access",
    ),
    404: errorResponse("Tree or sector not found"),
    409: errorResponse("A session is still working in the tree"),
    410: errorResponse("Already felled"),
    413: errorResponse("Too many tasks for one felling"),
  },
});

const growRoute = createRoute({
  method: "post",
  operationId: "growForest",
  path: "/{workspaceId}/grow",
  tags: ["Forest"],
  summary: "Grow a new forest from seeds",
  description:
    "Creates a project with one tree per seed. Each tree remembers the seed and log it came from; felled trees are never restored.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ project: ["create"], task: ["create"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: growBody } },
    },
  },
  responses: {
    200: jsonResponse("The new forest", growResultSchema),
    400: errorResponse("Invalid seed list"),
    403: errorResponse("Missing project:create or task:create permission"),
    404: errorResponse("Seed not found"),
    409: errorResponse("Another project in the workspace uses this key"),
  },
});

export const fellRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(fellRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const common = {
      workspaceId,
      actor: resolveForestActor(c),
      reason: body.reason,
      approvalId: body.approvalId,
    };
    const result =
      body.kind === "tree"
        ? await fellTrees({ ...common, kind: "tree", rootId: body.rootId })
        : await fellTrees({
            ...common,
            kind: "sector",
            sectorId: body.sectorId,
          });
    return c.json(maskForTokenCaller(c, result), 200);
  })
  .openapi(growRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await growForest({
      workspaceId,
      actor: resolveForestActor(c),
      ...body,
    });
    return c.json(maskForTokenCaller(c, result), 200);
  });
