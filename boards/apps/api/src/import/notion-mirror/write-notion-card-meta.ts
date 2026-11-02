import { inArray, sql } from "drizzle-orm";
import type db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { chunk } from "../writer/chunk";
import type { NotionCardMeta } from "./notion-card-meta";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MetaRow = { taskId: string; meta: NotionCardMeta };
// A stored row may predate the mirror: it has no Notion page yet.
type StoredMeta = Omit<NotionCardMeta, "notionPageId"> & {
  notionPageId: string | null;
};

// Writes only the Notion fields: what agents recorded on the card (executor,
// branch, PRs, cost) survives a re-import.
const NOTION_FIELDS = {
  kind: sql`excluded.kind`,
  severity: sql`excluded.severity`,
  backlogId: sql`excluded.backlog_id`,
  halfBaked: sql`excluded.half_baked`,
  report: sql`excluded.report`,
  notionPageId: sql`excluded.notion_page_id`,
  notionStatus: sql`excluded.notion_status`,
  notionEditedAt: sql`excluded.notion_edited_at`,
  updatedBy: sql`excluded.updated_by`,
  updatedAt: sql`excluded.updated_at`,
};

const COMPARED = [
  "kind",
  "severity",
  "backlogId",
  "halfBaked",
  "report",
  "notionPageId",
  "notionStatus",
] as const;

// Writes only the rows that differ, so an unchanged card keeps its history
// quiet. backlog_id is unique per workspace and resolveBacklogIds already
// picked one holder per value: IDs that move are released first and set
// second, and a clash left after that fails the run instead of being hidden.
// Returns how many existing cards changed in a field other than
// notion_edited_at; a new card is not counted.
export async function writeNotionCardMeta(
  tx: Transaction,
  input: { workspaceId: string; userId: string; rows: readonly MetaRow[] },
): Promise<number> {
  if (input.rows.length === 0) return 0;
  const stored = await loadStoredMeta(
    tx,
    input.rows.map(({ taskId }) => taskId),
  );

  let changed = 0;
  const writes: MetaRow[] = [];
  const moves: MetaRow[] = [];
  for (const row of input.rows) {
    const before = stored.get(row.taskId);
    const fields = before
      ? COMPARED.some((field) => before[field] !== row.meta[field])
      : true;
    const edited =
      before?.notionEditedAt?.getTime() !== row.meta.notionEditedAt?.getTime();
    if (before && fields) changed += 1;
    if (!fields && !edited) continue;
    const moving =
      before?.backlogId !== row.meta.backlogId && row.meta.backlogId !== null;
    writes.push(
      moving ? { ...row, meta: { ...row.meta, backlogId: null } } : row,
    );
    if (moving) moves.push(row);
  }

  await upsertMeta(tx, input, writes);
  await upsertMeta(tx, input, moves);
  return changed;
}

async function upsertMeta(
  tx: Transaction,
  input: { workspaceId: string; userId: string },
  rows: readonly MetaRow[],
) {
  const now = new Date();
  for (const batch of chunk(rows)) {
    await tx
      .insert(cardMetaTable)
      .values(
        batch.map(({ taskId, meta }) => ({
          taskId,
          workspaceId: input.workspaceId,
          ...meta,
          updatedBy: input.userId,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({ target: cardMetaTable.taskId, set: NOTION_FIELDS });
  }
}

async function loadStoredMeta(
  tx: Transaction,
  taskIds: readonly string[],
): Promise<Map<string, StoredMeta>> {
  const stored = new Map<string, StoredMeta>();
  for (const batch of chunk(taskIds)) {
    const rows = await tx
      .select({
        taskId: cardMetaTable.taskId,
        kind: cardMetaTable.kind,
        severity: cardMetaTable.severity,
        backlogId: cardMetaTable.backlogId,
        halfBaked: cardMetaTable.halfBaked,
        report: cardMetaTable.report,
        notionPageId: cardMetaTable.notionPageId,
        notionStatus: cardMetaTable.notionStatus,
        notionEditedAt: cardMetaTable.notionEditedAt,
      })
      .from(cardMetaTable)
      .where(inArray(cardMetaTable.taskId, batch));
    for (const { taskId, kind, ...meta } of rows) {
      stored.set(taskId, { ...meta, kind: kind === "bug" ? "bug" : "task" });
    }
  }
  return stored;
}
