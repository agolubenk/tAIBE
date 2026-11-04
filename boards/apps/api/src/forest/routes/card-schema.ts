import { nullableResponseTimestamp, z } from "../../openapi";
import { CARD_KINDS } from "../card/card-fields";
import { workspaceParam } from "./schema";

export const cardParam = workspaceParam.extend({ taskId: z.string() });

// Notion fields (R-024) and what the agent did on the card. Read-only from
// Notion while a card is mirrored (R-081).
export const cardMetaSchema = z
  .object({
    taskId: z.string(),
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
    mirrored: z.boolean().openapi({
      description:
        "Notion is the source of this card's Notion fields: it came from a Notion page and the mirror runs for the workspace (R-081). They are read-only while true.",
    }),
  })
  .openapi("ForestCardMeta");
