import { and, asc, eq, gt, isNull } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import { notebookSourceTable } from "../../database/notebook-schema";
import { projectTable, taskTable } from "../../database/schema";
import {
  type CardSourceRow,
  cardSourceText,
  cardSourceTitle,
} from "./card-source-text";
import { pruneSources, SOURCES_MAX } from "./list-sources";
import { openToEveryMember } from "./open-to-every-member";
import { sha256, upsertSource } from "./upsert-source";

const PAGE = 200;

export type CardSyncResult = { cards: number; changed: number; pruned: number };

// A project that becomes restricted leaves the notebook on the next sync.
function readCardPage(
  workspaceId: string,
  after: string | null,
): Promise<CardSourceRow[]> {
  return db
    .select({
      id: taskTable.id,
      number: taskTable.number,
      title: taskTable.title,
      status: taskTable.status,
      priority: taskTable.priority,
      description: taskTable.description,
      projectSlug: projectTable.slug,
      projectName: projectTable.name,
      kind: cardMetaTable.kind,
      severity: cardMetaTable.severity,
      backlogId: cardMetaTable.backlogId,
      halfBaked: cardMetaTable.halfBaked,
      report: cardMetaTable.report,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(cardMetaTable, eq(cardMetaTable.taskId, taskTable.id))
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
        openToEveryMember,
        after ? gt(taskTable.id, after) : undefined,
      ),
    )
    .orderBy(asc(taskTable.id))
    .limit(PAGE);
}

async function storedCardShas(workspaceId: string) {
  const rows = await db
    .select({
      ref: notebookSourceTable.ref,
      sha: notebookSourceTable.contentSha256,
    })
    .from(notebookSourceTable)
    .where(
      and(
        eq(notebookSourceTable.workspaceId, workspaceId),
        eq(notebookSourceTable.kind, "card"),
      ),
    )
    .limit(SOURCES_MAX);
  return new Map(rows.map((row) => [row.ref, row.sha]));
}

// The API owns the cards, so it syncs them itself: one source per card, ref
// is the task id, and only cards whose text changed are cut and embedded again.
export async function syncCardSources(
  workspaceId: string,
): Promise<CardSyncResult> {
  const stored = await storedCardShas(workspaceId);
  const keep: string[] = [];
  let changed = 0;
  let after: string | null = null;
  while (keep.length < SOURCES_MAX) {
    const page = await readCardPage(workspaceId, after);
    for (const card of page.slice(0, SOURCES_MAX - keep.length)) {
      keep.push(card.id);
      const text = cardSourceText(card);
      if (stored.get(card.id) === sha256(text)) continue;
      await upsertSource({
        workspaceId,
        kind: "card",
        ref: card.id,
        title: cardSourceTitle(card),
        text,
      });
      changed += 1;
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1]?.id ?? null;
  }
  const pruned = await pruneSources(workspaceId, "card", keep);
  return { cards: keep.length, changed, pruned };
}
