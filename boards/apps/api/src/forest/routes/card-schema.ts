import { nullableResponseTimestamp, z } from "../../openapi";
import { CARD_KINDS } from "../card/card-fields";
import { workspaceParam } from "./schema";

export const cardParam = workspaceParam.extend({ taskId: z.string() });

// Notion fields (R-024) and what the agent did on the card. `mirrored` is
// true only while the Notion mirror runs for the workspace: then the Notion
// fields are read-only (R-081); with the mirror off (R-084) they are the
// owner's to change even on a card imported from Notion.
export const cardMetaSchema = z
  .object({
    taskId: z.string(),
    mirrored: z.boolean(),
    kind: z.enum(CARD_KINDS),
    severity: z.string().nullable(),
    backlogId: z.string().nullable(),
    halfBaked: z.boolean(),
    report: z.string().nullable(),
    notionPageId: z.string().nullable(),
    notionStatus: z.string().nullable(),
    executor: z.string().nullable(),
    branch: z.string().nullable(),
    pullRequests: z.array(z.string()),
    files: z.array(z.string()),
    tokens: z.number().nullable(),
    costUsd: z.number().nullable(),
    contextPack: z.string().nullable(),
    updatedBy: z.string().nullable(),
    updatedAt: nullableResponseTimestamp,
  })
  .openapi("ForestCardMeta");
