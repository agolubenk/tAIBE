import { eq } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";

export type CardMetaRow = typeof cardMetaTable.$inferSelect;

// notionEditedAt is the importer's bookkeeping (R-080), not a card field.
export type CardMeta = Omit<
  CardMetaRow,
  "workspaceId" | "costUsd" | "updatedBy" | "updatedAt" | "notionEditedAt"
> & {
  costUsd: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
  // True only while the Notion mirror runs for the workspace: the Notion
  // fields stay read-only then (R-081). With the mirror off they are the
  // owner's to change (R-084), so a card imported long ago answers false.
  mirrored: boolean;
};

// A card nobody wrote fields for answers the defaults, without a row.
export function toCardMeta(
  taskId: string,
  row?: CardMetaRow,
  mirrorActive = false,
): CardMeta {
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
      mirrored: false,
      executor: null,
      branch: null,
      pullRequests: [],
      files: [],
      tokens: null,
      costUsd: null,
      contextPack: null,
      updatedBy: null,
      updatedAt: null,
    };
  }
  const { workspaceId: _, notionEditedAt: _editedAt, costUsd, ...rest } = row;
  return {
    ...rest,
    costUsd: costUsd === null ? null : Number(costUsd),
    mirrored: mirrorActive && Boolean(row.notionPageId),
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
