import { z } from "zod";

export const MAX_BATCH_VERSIONS = 200;

export const draftMatchSchema = z.object({
  entityId: z.string(),
  versionId: z.string(),
  path: z.string(),
  kind: z.string(),
  match: z
    .object({
      workspaceId: z.string(),
      workspaceName: z.string(),
      versionId: z.string(),
      number: z.number(),
    })
    .nullable()
    .describe(
      "An approved version with the same path and blob sha in a workspace the caller can read, or null",
    ),
});

export const draftMatchesSchema = z.object({
  drafts: z.array(draftMatchSchema),
});

export const approveMatchingBody = z.object({
  versionIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BATCH_VERSIONS)
    .describe("Draft version ids from the matches list; each is re-checked"),
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
    .describe("Ids that are no longer open drafts or no longer match"),
});
