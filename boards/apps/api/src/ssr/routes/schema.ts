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

export const syncBody = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{6,40}$/i),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        content: z.string().max(600_000).optional(),
      }),
    )
    .max(400),
  deleted: z.array(z.string().min(1).max(500)).max(400).optional(),
});

export const approveBody = z.object({
  versionId: z.string(),
  blobSha: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(
      "The draft's blob sha from the open diff (toBlobSha); re-checked",
    ),
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
  toVersionId: z.string(),
  toBlobSha: z
    .string()
    .describe(
      "Aggregate sha of the bytes shown on the `to` side; approve and reject send it back",
    ),
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
