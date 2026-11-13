import { z } from "zod";

export const workspaceParam = z.object({
  workspaceId: z.string(),
});

export const entityParam = z.object({
  workspaceId: z.string(),
  entityId: z.string(),
});

const versionSpec = z.union([
  z.literal("latest"),
  z.literal("-1"),
  z.string().regex(/^\d+$/),
]);

// TB-129. The sync is the whole manifest (RU-13 archives what it leaves
// out), so the corpus cannot be split into several syncs: the manifest
// limit is the corpus limit. An entry without content is a path and a sha,
// at most ~600 bytes; 5000 of them plus 5000 deleted paths are 5.2 MiB, under
// the route's 12 MB body bound, which also caps the content.
export const SYNC_BODY_BYTES = 12 * 1024 * 1024;
export const SYNC_MANIFEST_MAX = 5000;
export const SYNC_CONTENT_MAX = 400;
export const SYNC_PATH_MAX = 500;

export const syncBody = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{6,40}$/i),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(SYNC_PATH_MAX),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        content: z.string().max(600_000).optional(),
      }),
    )
    .max(SYNC_MANIFEST_MAX)
    .refine(
      (files) =>
        files.filter((file) => file.content !== undefined).length <=
        SYNC_CONTENT_MAX,
      {
        message: `at most ${SYNC_CONTENT_MAX} files with content in one sync`,
      },
    ),
  deleted: z
    .array(z.string().min(1).max(SYNC_PATH_MAX))
    .max(SYNC_MANIFEST_MAX)
    .optional(),
});

export const approveBody = z.object({
  versionId: z.string(),
});

export const rollbackBody = z.object({
  toVersion: z.number().int().positive(),
});

export const contentQuery = z.object({
  version: versionSpec.optional(),
});

export const diffQuery = z.object({
  from: versionSpec.default("latest"),
  to: versionSpec.default("-1"),
});

export const timelineQuery = z.object({
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const versionSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  status: z.string(),
  origin: z.string(),
  message: z.string().nullable(),
  commitSha: z.string().nullable(),
  createdAt: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
});

export const entitySchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  path: z.string(),
  status: z.string(),
  latestVersionId: z.string().nullable(),
  updatedAt: z.string(),
  versions: z.array(versionSummarySchema),
});

export const syncResultSchema = z.object({
  commitSha: z.string(),
  created: z.array(
    z.object({
      entity: z.string(),
      kind: z.string(),
      versionId: z.string(),
      number: z.number(),
      status: z.string(),
    }),
  ),
  bumped: z.array(
    z.object({
      entity: z.string(),
      kind: z.string(),
      versionId: z.string(),
      number: z.number(),
    }),
  ),
  archived: z.array(z.string()),
  unchanged: z.number(),
  secretHits: z.array(z.object({ path: z.string(), label: z.string() })),
});

export const servedSchema = z.object({
  versionId: z.string(),
  number: z.number(),
  blobSha: z.string(),
  files: z.array(
    z.object({ path: z.string(), content: z.string(), sha256: z.string() }),
  ),
});

export const diffSchema = z.object({
  from: z.number(),
  to: z.number(),
  files: z.array(z.object({ path: z.string(), diff: z.string() })),
});

export const timelineSchema = z.object({
  events: z.array(
    z.object({
      versionId: z.string(),
      number: z.number(),
      status: z.string(),
      origin: z.string(),
      message: z.string().nullable(),
      commitSha: z.string().nullable(),
      createdAt: z.string(),
      entityId: z.string(),
      entityName: z.string(),
      entityKind: z.string(),
      entityPath: z.string(),
    }),
  ),
});

export const conflictSchema = z.object({
  conflicts: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      baselineSha: z.string(),
      repoSha: z.string(),
      detectedAt: z.string(),
      resolvedAt: z.string().nullable(),
    }),
  ),
});
