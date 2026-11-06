import { z } from "zod";

export const MAX_BATCH_VERSIONS = 200;
// 200 items of a 64-char id and a 64-char sha are about 31 KB of compact JSON.
export const APPROVE_MATCHING_BODY_BYTES = 32 * 1024;

const blobSha = z.string().regex(/^[0-9a-f]{64}$/);

export const draftMatchSchema = z.object({
  entityId: z.string(),
  versionId: z.string(),
  path: z.string(),
  kind: z.string(),
  blobSha: z.string().describe("The draft's aggregate sha; send it back"),
  match: z
    .object({
      workspaceId: z.string(),
      workspaceName: z.string(),
      versionId: z.string(),
      number: z.number(),
    })
    .nullable()
    .describe(
      "A version with the same path and blob sha that the caller approved, in a workspace the caller can read, or null",
    ),
});

export const draftMatchesSchema = z.object({
  drafts: z.array(draftMatchSchema),
});

export const approveMatchingBody = z.object({
  items: z
    .array(
      z.object({
        versionId: z.string().min(1).max(64),
        blobSha: blobSha.describe("The draft bytes the owner saw"),
      }),
    )
    .min(1)
    .max(MAX_BATCH_VERSIONS)
    .describe(
      "Drafts from the matches list with the blob sha shown; each is re-checked",
    ),
});

export const approveMatchingResultSchema = z.object({
  approved: z.number(),
  versionIds: z.array(z.string()),
});

export const batchConflictSchema = z.object({
  message: z.string(),
  code: z.string(),
  versionIds: z
    .array(z.string())
    .describe(
      "Ids that changed, were decided, or no longer match; nothing was approved",
    ),
});
