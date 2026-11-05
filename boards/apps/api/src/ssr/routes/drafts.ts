import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requestWorkspaceScope } from "../../utils/api-key-workspace-scope";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { approveMatchingDrafts, DraftBatchConflict } from "../approve-matching";
import { listDraftMatches } from "../draft-matches";
import { readableWorkspaces } from "../readable-workspaces";
import {
  approveMatchingBody,
  approveMatchingResultSchema,
  batchConflictSchema,
  draftMatchesSchema,
} from "./drafts-schema";
import { ownerUiOnly } from "./owner-ui";
import { workspaceParam } from "./schema";

type SsrVariables = BaseVariables & { workspaceId: string };

const matchesRoute = createRoute({
  method: "get",
  operationId: "listSsrDraftMatches",
  path: "/{workspaceId}/drafts/matches",
  tags: ["SSR"],
  summary: "Open drafts and the approved version each one is identical to",
  description:
    "A draft matches when a version with the same entity path and the same blob sha was approved (or auto-bumped by sync) in this workspace or another workspace the caller can read. Other workspaces are never revealed.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Open drafts with their match", draftMatchesSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const approveMatchingRoute = createRoute({
  method: "post",
  operationId: "approveMatchingSsrDrafts",
  path: "/{workspaceId}/drafts/approve-matching",
  tags: ["SSR"],
  summary:
    "Approve every listed draft that matches an approved version (owner UI only)",
  description:
    "Takes draft ids from the matches list and re-checks each on the server in one transaction: all are approved, or none are.",
  middleware: [
    ownerUiOnly(),
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: approveMatchingBody } },
    },
  },
  responses: {
    200: jsonResponse("Approved", approveMatchingResultSchema),
    400: errorResponse("More than 200 ids, or an empty list"),
    403: errorResponse("Not the owner's browser session"),
    409: jsonResponse(
      "Some ids are no longer open drafts or no longer match; nothing was approved",
      batchConflictSchema,
    ),
  },
});

export const ssrDraftRoutes = apiRouter<SsrVariables>()
  .openapi(matchesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const readable = await readableWorkspaces(
      c.get("userId"),
      requestWorkspaceScope(c),
      workspaceId,
    );
    return c.json(
      { drafts: await listDraftMatches(workspaceId, readable) },
      200,
    );
  })
  .openapi(approveMatchingRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { versionIds } = c.req.valid("json");
    const userId = c.get("userId");
    const readable = await readableWorkspaces(userId, undefined, workspaceId);
    try {
      return c.json(
        await approveMatchingDrafts(workspaceId, versionIds, readable, userId),
        200,
      );
    } catch (error) {
      if (error instanceof DraftBatchConflict) {
        return c.json(
          {
            message: error.message,
            code: "SSR_DRAFTS_CHANGED",
            versionIds: error.versionIds,
          },
          409,
        );
      }
      throw error;
    }
  });
