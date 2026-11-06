import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  ssrBlobTable,
  ssrConflictTable,
  ssrEntityTable,
} from "../../database/ssr-schema";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { approveDraft, rejectDraft, rollbackToVersion } from "../approve";
import { pushChangeset } from "../pushback";
import {
  diffVersions,
  listEntities,
  parseVersionSpec,
  serveVersion,
  timeline,
} from "../serve";
import { SyncError, syncCorpus } from "../sync";
import { assertOwnerUi } from "./owner-ui";
import {
  approveBody,
  conflictSchema,
  contentQuery,
  diffQuery,
  diffSchema,
  entityParam,
  entitySchema,
  rollbackBody,
  servedSchema,
  syncBody,
  syncResultSchema,
  timelineQuery,
  timelineSchema,
  workspaceParam,
} from "./schema";

// tAI-Boards SSR (spec approved 31.10): the Mac sync agent writes versions,
// agents and the owner read them, and only the owner's browser session
// approves, rejects and rolls back (RU-6, RU-7) — see ./owner-ui.
const SYNC_BODY_BYTES = 12 * 1024 * 1024;

type SsrVariables = BaseVariables & { workspaceId: string };

const syncRoute = createRoute({
  method: "post",
  operationId: "syncSsrCorpus",
  path: "/{workspaceId}/sync",
  tags: ["SSR"],
  summary: "Sync the SSR corpus from a git commit",
  description:
    "The Mac sync agent sends the corpus manifest at a git commit plus content for files new to the server. Existing entities auto-bump (a merge into main is the owner's consent); new entities wait as drafts; secrets and paths outside the corpus are rejected.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SYNC_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: syncBody } },
    },
  },
  responses: {
    200: jsonResponse("What the sync changed", syncResultSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    409: errorResponse("Corpus allowlist or secret scan rejection"),
    413: errorResponse("Request body is too large"),
  },
});

const entitiesRoute = createRoute({
  method: "get",
  operationId: "listSsrEntities",
  path: "/{workspaceId}/entities",
  tags: ["SSR"],
  summary: "List SSR entities with their versions",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse(
      "Entities",
      z.object({ entities: z.array(entitySchema) }),
    ),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const contentRoute = createRoute({
  method: "get",
  operationId: "getSsrContent",
  path: "/{workspaceId}/entities/{entityId}/content",
  tags: ["SSR"],
  summary: "Serve a version's files (latest by default, -1 or N)",
  description:
    "ETag is the version's snapshot sha; the resolved version id rides in every answer so a relative request stays reproducible.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: entityParam, query: contentQuery },
  responses: {
    200: jsonResponse("Served version", servedSchema),
    304: { description: "Not modified" },
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Entity or version not found"),
  },
});

const diffRoute = createRoute({
  method: "get",
  operationId: "getSsrDiff",
  path: "/{workspaceId}/entities/{entityId}/diff",
  tags: ["SSR"],
  summary: "Server-side unified diff between two versions",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: entityParam, query: diffQuery },
  responses: {
    200: jsonResponse("Diff", diffSchema),
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Entity or version not found"),
  },
});

const timelineRoute = createRoute({
  method: "get",
  operationId: "listSsrTimeline",
  path: "/{workspaceId}/timeline",
  tags: ["SSR"],
  summary: "The evolution feed: versions across all entities, newest first",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam, query: timelineQuery },
  responses: {
    200: jsonResponse("Timeline", timelineSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const approveRoute = createRoute({
  method: "post",
  operationId: "approveSsrDraft",
  path: "/{workspaceId}/entities/{entityId}/approve",
  tags: ["SSR"],
  summary: "Approve a draft version (owner UI only)",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: entityParam,
    body: {
      required: true,
      content: { "application/json": { schema: approveBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "Approved",
      z.object({
        entityId: z.string(),
        versionId: z.string(),
        number: z.number(),
      }),
    ),
    403: errorResponse("Not the owner's browser session"),
    409: errorResponse("Version is not an open draft"),
  },
});

const rejectRoute = createRoute({
  method: "post",
  operationId: "rejectSsrDraft",
  path: "/{workspaceId}/entities/{entityId}/reject",
  tags: ["SSR"],
  summary: "Reject a draft version (owner UI only)",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: entityParam,
    body: {
      required: true,
      content: { "application/json": { schema: approveBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "Rejected",
      z.object({ entityId: z.string(), versionId: z.string() }),
    ),
    403: errorResponse("Not the owner's browser session"),
    409: errorResponse("Version is not an open draft"),
  },
});

const rollbackRoute = createRoute({
  method: "post",
  operationId: "rollbackSsrEntity",
  path: "/{workspaceId}/entities/{entityId}/rollback",
  tags: ["SSR"],
  summary:
    "Restore an old version and push it to the repo immediately (owner UI only)",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: entityParam,
    body: {
      required: true,
      content: { "application/json": { schema: rollbackBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "Rolled back",
      z.object({
        entityId: z.string(),
        versionId: z.string(),
        number: z.number(),
        restoredFrom: z.number(),
        push: z.object({
          pushed: z.boolean(),
          commitSha: z.string().nullable(),
          conflicts: z.array(
            z.object({
              path: z.string(),
              baselineSha: z.string(),
              repoSha: z.string(),
            }),
          ),
        }),
      }),
    ),
    403: errorResponse("Not the owner's browser session"),
    409: errorResponse("Version is already latest"),
  },
});

const conflictsRoute = createRoute({
  method: "get",
  operationId: "listSsrConflicts",
  path: "/{workspaceId}/conflicts",
  tags: ["SSR"],
  summary: "Push-back conflicts, newest first",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Conflicts", conflictSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const resolveConflictRoute = createRoute({
  method: "post",
  operationId: "resolveSsrConflict",
  path: "/{workspaceId}/conflicts/{conflictId}/resolve",
  tags: ["SSR"],
  summary: "Mark a conflict resolved (owner UI only)",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: workspaceParam.extend({ conflictId: z.string() }),
  },
  responses: {
    200: jsonResponse("Resolved", z.object({ resolved: z.boolean() })),
    403: errorResponse("Not the owner's browser session"),
  },
});

const contentByNameRoute = createRoute({
  method: "get",
  operationId: "getSsrContentByName",
  path: "/{workspaceId}/entities/by-name/{name}/content",
  tags: ["SSR"],
  summary: "Serve a version's files by entity name and kind",
  description:
    "The MCP tools resolve names this way: kind narrows the lookup (skill, rule, agent, genome, prompt, nerve, config, product-prompt).",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: {
    params: workspaceParam.extend({ name: z.string() }),
    query: contentQuery.extend({ kind: z.string().optional() }),
  },
  responses: {
    200: jsonResponse("Served version", servedSchema),
    304: { description: "Not modified" },
    403: errorResponse("Missing workspace:read permission"),
    404: errorResponse("Entity or version not found"),
  },
});

const knownShasRoute = createRoute({
  method: "post",
  operationId: "knownSsrShas",
  path: "/{workspaceId}/known-shas",
  tags: ["SSR"],
  summary: "Which blob shas the server already stores",
  description:
    "The Mac sync agent sends candidate shas and uploads content only for the rest.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            shas: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonResponse("Known shas", z.object({ shas: z.array(z.string()) })),
    403: errorResponse("Missing workspace:manage_settings permission"),
  },
});

export const ssrRoutes = apiRouter<SsrVariables>()
  .openapi(knownShasRoute, async (c) => {
    const { shas } = c.req.valid("json");
    const rows = await db
      .select({ sha256: ssrBlobTable.sha256 })
      .from(ssrBlobTable)
      .where(inArray(ssrBlobTable.sha256, shas));
    return c.json({ shas: rows.map((row) => row.sha256) }, 200);
  })
  .openapi(knownShasRoute, async (c) => {
    const { shas } = c.req.valid("json");
    const rows = await db
      .select({ sha256: ssrBlobTable.sha256 })
      .from(ssrBlobTable)
      .where(inArray(ssrBlobTable.sha256, shas));
    return c.json({ shas: rows.map((row) => row.sha256) }, 200);
  })
  .openapi(contentByNameRoute, async (c) => {
    const { workspaceId, name } = c.req.valid("param");
    const { kind, version } = c.req.valid("query");
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(
        and(
          eq(ssrEntityTable.workspaceId, workspaceId),
          eq(ssrEntityTable.name, name),
          kind ? eq(ssrEntityTable.kind, kind) : undefined,
        ),
      );
    if (!entity) throw new HTTPException(404, { message: "Entity not found" });
    const served = await serveVersion(
      workspaceId,
      entity.id,
      parseVersionSpec(version),
    );
    const etag = `"${served.blobSha}"`;
    if (c.req.header("If-None-Match") === etag) {
      return c.body(null, 304, { ETag: etag });
    }
    return c.json(served, 200, { ETag: etag });
  })
  .openapi(syncRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      return c.json(await syncCorpus(workspaceId, body, c.get("userId")), 200);
    } catch (error) {
      if (error instanceof SyncError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  })
  .openapi(entitiesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json({ entities: await listEntities(workspaceId) }, 200);
  })
  .openapi(contentRoute, async (c) => {
    const { workspaceId, entityId } = c.req.valid("param");
    const { version } = c.req.valid("query");
    const served = await serveVersion(
      workspaceId,
      entityId,
      parseVersionSpec(version),
    );
    const etag = `"${served.blobSha}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return c.json(served, 200, { ETag: etag });
  })
  .openapi(diffRoute, async (c) => {
    const { workspaceId, entityId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    return c.json(
      await diffVersions(
        workspaceId,
        entityId,
        parseVersionSpec(from),
        parseVersionSpec(to),
      ),
      200,
    );
  })
  .openapi(timelineRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { take, skip } = c.req.valid("query");
    return c.json({ events: await timeline(workspaceId, take, skip) }, 200);
  })
  .openapi(approveRoute, async (c) => {
    assertOwnerUi(c.req.raw.headers);
    const { workspaceId, entityId } = c.req.valid("param");
    const { versionId } = c.req.valid("json");
    return c.json(
      await approveDraft(workspaceId, entityId, versionId, c.get("userId")),
      200,
    );
  })
  .openapi(rejectRoute, async (c) => {
    assertOwnerUi(c.req.raw.headers);
    const { workspaceId, entityId } = c.req.valid("param");
    const { versionId } = c.req.valid("json");
    return c.json(
      await rejectDraft(workspaceId, entityId, versionId, c.get("userId")),
      200,
    );
  })
  .openapi(rollbackRoute, async (c) => {
    assertOwnerUi(c.req.raw.headers);
    const { workspaceId, entityId } = c.req.valid("param");
    const { toVersion } = c.req.valid("json");
    const rollback = await rollbackToVersion(
      workspaceId,
      entityId,
      toVersion,
      c.get("userId"),
    );
    // Immediate push-back (spec N-3): the repo catches up within minutes,
    // not at the nightly window. A push failure must not lose the rollback —
    // the answer reports what happened to the push.
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, entityId));
    const push = await pushChangeset(
      workspaceId,
      `tAI-Boards SSR: restore ${entity?.name ?? entityId} from v${toVersion}`,
    ).catch(() => ({
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
    }));
    return c.json({ ...rollback, push }, 200);
  })
  .openapi(conflictsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const rows = await db
      .select()
      .from(ssrConflictTable)
      .where(eq(ssrConflictTable.workspaceId, workspaceId))
      .orderBy(desc(ssrConflictTable.detectedAt))
      .limit(100);
    return c.json(
      {
        conflicts: rows.map((row) => ({
          id: row.id,
          path: row.path,
          baselineSha: row.baselineSha,
          repoSha: row.repoSha,
          detectedAt: row.detectedAt.toISOString(),
          resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        })),
      },
      200,
    );
  })
  .openapi(resolveConflictRoute, async (c) => {
    assertOwnerUi(c.req.raw.headers);
    const { conflictId } = c.req.valid("param");
    await db
      .update(ssrConflictTable)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(ssrConflictTable.id, conflictId));
    return c.json({ resolved: true }, 200);
  });
