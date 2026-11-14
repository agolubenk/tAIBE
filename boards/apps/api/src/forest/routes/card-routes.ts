import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { resolveForestActor } from "../actor";
import { readAgentHeaders } from "../agent-guard/agent-headers";
import { loadCardMeta, toCardMeta } from "../card/card-meta";
import { cardMetaWrite } from "../card/card-patch";
import { setCardMeta } from "../card/set-card-meta";
import { assertTaskInWorkspace } from "../task-scope";
import { cardMetaSchema, cardParam } from "./card-schema";

const getCardMetaRoute = createRoute({
  method: "get",
  operationId: "getForestCardMeta",
  path: "/{workspaceId}/cards/{taskId}/meta",
  tags: ["Forest"],
  summary: "Get a card's Notion and agent fields",
  description:
    "A card nobody wrote fields for answers the defaults: kind task, not half-baked, empty lists.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: cardParam },
  responses: {
    200: jsonResponse("The card's fields", cardMetaSchema),
    403: errorResponse("Missing task:read permission or project access"),
    404: errorResponse("Task not found"),
  },
});

const setCardMetaRoute = createRoute({
  method: "put",
  operationId: "setForestCardMeta",
  path: "/{workspaceId}/cards/{taskId}/meta",
  tags: ["Forest"],
  summary: "Change a card's Notion and agent fields",
  description:
    "Sends only the fields to change; null clears one. expectedMetaRevision (the revision from the read) refuses the write if the fields changed since. An agent writes under its lease (x-t-boards-session, x-t-boards-fence) and changes Notion fields only on cards it created. Half-baked moves only from the owner's own session. A card mirrored from Notion keeps its Notion fields read-only.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: cardParam,
    body: {
      required: true,
      content: { "application/json": { schema: cardMetaWrite } },
    },
  },
  responses: {
    200: jsonResponse("The card's fields after the change", cardMetaSchema),
    403: errorResponse(
      "Missing task:update permission, or the fields are not this actor's to change",
    ),
    404: errorResponse("Task not found"),
    409: errorResponse(
      "No live lease of this session, the Backlog ID is taken, or revision_conflict: the fields moved past expectedMetaRevision (the message names the current revision)",
    ),
  },
});

export const cardRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(getCardMetaRoute, async (c) => {
    const { workspaceId, taskId } = c.req.valid("param");
    await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    return c.json(toCardMeta(taskId, await loadCardMeta(taskId)), 200);
  })
  .openapi(setCardMetaRoute, async (c) => {
    const { workspaceId, taskId } = c.req.valid("param");
    await assertTaskInWorkspace(taskId, workspaceId, c.get("userId"));
    const { expectedMetaRevision, ...patch } = c.req.valid("json");
    const meta = await setCardMeta({
      workspaceId,
      taskId,
      actor: resolveForestActor(c),
      headers: readAgentHeaders(c),
      patch,
      expectedRevision: expectedMetaRevision,
    });
    return c.json(meta, 200);
  });
