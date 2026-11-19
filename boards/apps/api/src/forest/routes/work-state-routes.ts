import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { maskForTokenCaller } from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { resolveForestActor } from "../actor";
import { assertTaskInWorkspace } from "../task-scope";
import { listWorkState } from "../work-state/list-work-state";
import { clearWorkState, setWorkState } from "../work-state/set-work-state";
import { workspaceParam } from "./schema";
import {
  workStateBody,
  workStateListSchema,
  workStateSavedSchema,
} from "./work-state-schema";

const listWorkStateRoute = createRoute({
  method: "get",
  operationId: "listForestWorkState",
  path: "/{workspaceId}/work-state",
  tags: ["Forest"],
  summary: "List sessions' working state",
  description:
    "What each session is doing: its step, branch, what it waits for and its card, latest first. Sessions on cards of projects you may not open are left out.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Working state of sessions", workStateListSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

const setWorkStateRoute = createRoute({
  method: "put",
  operationId: "setForestWorkState",
  path: "/{workspaceId}/work-state",
  tags: ["Forest"],
  summary: "Set your session's working state",
  description:
    "Replaces the calling session's step, branch, what it waits for and its card. Agents tell sessions apart by x-t-boards-session. A session silent for 30 days is dropped.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: workStateBody } },
    },
  },
  responses: {
    200: jsonResponse("The saved state", workStateSavedSchema),
    403: errorResponse("Missing task:update permission or project access"),
    404: errorResponse("Task not found"),
    410: errorResponse("The task was felled"),
  },
});

const clearWorkStateRoute = createRoute({
  method: "delete",
  operationId: "clearForestWorkState",
  path: "/{workspaceId}/work-state",
  tags: ["Forest"],
  summary: "Clear your session's working state",
  description: "Removes the calling session's row when its work is done.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse(
      "Whether a row was removed",
      z.object({ removed: z.boolean() }),
    ),
    403: errorResponse("Missing task:update permission"),
  },
});

export const workStateRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>()
  .openapi(listWorkStateRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      maskForTokenCaller(c, await listWorkState(workspaceId, c.get("userId"))),
      200,
    );
  })
  .openapi(setWorkStateRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const taskId = body.taskId ?? null;
    if (taskId) {
      await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    }
    const saved = await setWorkState(workspaceId, resolveForestActor(c), {
      taskId,
      step: body.step,
      branch: body.branch ?? null,
      waiting: body.waiting ?? null,
    });
    return c.json(maskForTokenCaller(c, saved), 200);
  })
  .openapi(clearWorkStateRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      maskForTokenCaller(
        c,
        await clearWorkState(workspaceId, resolveForestActor(c)),
      ),
      200,
    );
  });
