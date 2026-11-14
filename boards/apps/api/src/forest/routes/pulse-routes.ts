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
import { listFires } from "../read/list-fires";
import { listJournal } from "../read/list-journal";
import {
  firesQuery,
  firesSchema,
  journalQuery,
  journalSchema,
} from "./pulse-schema";
import { workspaceParam } from "./schema";

const listJournalRoute = createRoute({
  method: "get",
  operationId: "listForestJournal",
  path: "/{workspaceId}/journal",
  tags: ["Forest"],
  summary: "List what agents did",
  description:
    "The journal of actions on the board, refused ones included, newest first. Entries about cards of projects you may not open are left out; so are entries about removed cards unless you may open every project.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: journalQuery },
  responses: {
    200: jsonResponse("A page of the journal", journalSchema),
    400: errorResponse("Invalid cursor"),
    403: errorResponse("Missing task:read permission"),
  },
});

const listFiresRoute = createRoute({
  method: "get",
  operationId: "listForestFires",
  path: "/{workspaceId}/fires",
  tags: ["Forest"],
  summary: "List what is on fire",
  description:
    "Open bugs and urgent cards you may open: critical and high bugs first, then urgent cards, then other bugs, oldest first in each group. `total` counts them all.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: firesQuery },
  responses: {
    200: jsonResponse("Open bugs and urgent cards", firesSchema),
    403: errorResponse("Missing task:read permission"),
  },
});

export const pulseRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listJournalRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { actor, outcome, cursor, take } = c.req.valid("query");
    return c.json(
      maskForTokenCaller(
        c,
        await listJournal({
          workspaceId,
          userId: c.get("userId"),
          actor,
          denied: outcome === "denied",
          cursor,
          take,
        }),
        ["nextCursor"],
      ),
      200,
    );
  })
  .openapi(listFiresRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { take } = c.req.valid("query");
    return c.json(
      maskForTokenCaller(
        c,
        await listFires({ workspaceId, userId: c.get("userId"), take }),
      ),
      200,
    );
  });
