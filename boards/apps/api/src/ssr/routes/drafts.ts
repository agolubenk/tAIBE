import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requestWorkspaceScope } from "../../utils/api-key-workspace-scope";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { approveMatchingDrafts, DraftBatchConflict } from "../approve-matching";
import { listOpenDrafts, withMatches } from "../draft-matches";
import { readableWorkspaces } from "../readable-workspaces";
import {
  APPROVE_MATCHING_BODY_BYTES,
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
  summary:
    "Open drafts and the version you approved that each one is identical to",
  description:
    "A draft matches when the caller approved a version with the same entity path and the same blob sha, in this workspace or another workspace the caller can read, and no later rollback undid it. Sync auto-bumps do not count. Drafts of archived entities, drafts below a newer version and bytes the entity rejected never match. Other workspaces are never revealed.",
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
    "Approve every listed draft that matches a version you approved (owner UI only)",
  description:
    "Takes drafts from the matches list with the blob sha the owner saw and re-checks each on the server in one transaction: all are approved, or none are.",
  middleware: [
    ownerUiOnly(),
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(APPROVE_MATCHING_BODY_BYTES),
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
    400: errorResponse(
      "Empty list, more than 200 items, an id over 64 characters or a malformed sha",
    ),
    403: errorResponse("Not the owner's browser session"),
    409: jsonResponse(
      "Some drafts changed, were decided, or no longer match; nothing was approved",
      batchConflictSchema,
    ),
    413: errorResponse("Request body is too large"),
  },
});

export const ssrDraftRoutes = apiRouter<SsrVariables>()
  .openapi(matchesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const drafts = await listOpenDrafts(workspaceId);
    if (!drafts.some((draft) => draft.eligible)) {
      return c.json(
        { drafts: await withMatches(drafts, new Map(), c.get("userId")) },
        200,
      );
    }
    const readable = await readableWorkspaces(
      c.get("userId"),
      requestWorkspaceScope(c),
      workspaceId,
    );
    return c.json(
      { drafts: await withMatches(drafts, readable, c.get("userId")) },
      200,
    );
  })
  .openapi(approveMatchingRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { items } = c.req.valid("json");
    const userId = c.get("userId");
    const readable = await readableWorkspaces(userId, undefined, workspaceId);
    try {
      return c.json(
        await approveMatchingDrafts(workspaceId, items, readable, userId),
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
