import { eq } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { isMirroredCard } from "./card-mirror";

export type CardMetaRow = typeof cardMetaTable.$inferSelect;

// notionEditedAt is the importer's bookkeeping (R-080), not a card field.
export type CardMeta = Omit<
  CardMetaRow,
  "workspaceId" | "costUsd" | "updatedBy" | "updatedAt" | "notionEditedAt"
> & {
  costUsd: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
  // Notion fields read-only now (R-081, TB-71): computed, not stored.
  mirrored: boolean;
};

// A card nobody wrote fields for answers the defaults, without a row.
export function toCardMeta(taskId: string, row?: CardMetaRow): CardMeta {
  if (!row) {
    return {
      taskId,
      kind: "task",
      severity: null,
      backlogId: null,
      halfBaked: false,
      report: null,
      notionPageId: null,
      notionStatus: null,
      executor: null,
      branch: null,
      pullRequests: [],
      files: [],
      tokens: null,
      costUsd: null,
      contextPack: null,
      updatedBy: null,
      updatedAt: null,
      mirrored: false,
    };
  }
  const { workspaceId, notionEditedAt: _editedAt, costUsd, ...rest } = row;
  return {
    ...rest,
    costUsd: costUsd === null ? null : Number(costUsd),
    mirrored: isMirroredCard(workspaceId, row.notionPageId),
  };
}

export async function loadCardMeta(taskId: string) {
  const [row] = await db
    .select()
    .from(cardMetaTable)
    .where(eq(cardMetaTable.taskId, taskId))
    .limit(1);
  return row;
}
