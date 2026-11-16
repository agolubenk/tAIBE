import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import db from "../../database";
import {
  type NotebookSourceKind,
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";

// A workspace holds a few hundred sources; the cap only guards memory.
export const SOURCES_MAX = 5000;

export async function listSources(workspaceId: string, model: string) {
  const rows = await db
    .select({
      kind: notebookSourceTable.kind,
      ref: notebookSourceTable.ref,
      title: notebookSourceTable.title,
      contentSha256: notebookSourceTable.contentSha256,
      chars: notebookSourceTable.chars,
      addedByKind: notebookSourceTable.addedByKind,
      addedBy: notebookSourceTable.addedBy,
      updatedAt: notebookSourceTable.updatedAt,
      chunks: sql<number>`count(${notebookChunkTable.id})::int`,
      embedded: sql<number>`count(${notebookChunkTable.id}) filter (where ${notebookChunkTable.embedModel} = ${model} and ${notebookChunkTable.embedding} is not null)::int`,
    })
    .from(notebookSourceTable)
    .leftJoin(
      notebookChunkTable,
      eq(notebookChunkTable.sourceId, notebookSourceTable.id),
    )
    .where(eq(notebookSourceTable.workspaceId, workspaceId))
    .groupBy(notebookSourceTable.id)
    .orderBy(asc(notebookSourceTable.kind), asc(notebookSourceTable.ref))
    .limit(SOURCES_MAX);
  return rows;
}

// The sync sends every ref it still has; the rest of that kind is gone.
export async function pruneSources(
  workspaceId: string,
  kind: NotebookSourceKind,
  keep: string[],
): Promise<number> {
  const scope = and(
    eq(notebookSourceTable.workspaceId, workspaceId),
    eq(notebookSourceTable.kind, kind),
  );
  const deleted = await db
    .delete(notebookSourceTable)
    .where(
      keep.length
        ? and(scope, notInArray(notebookSourceTable.ref, keep))
        : scope,
    )
    .returning({ id: notebookSourceTable.id });
  return deleted.length;
}

export async function deleteSources(
  workspaceId: string,
  kind: NotebookSourceKind,
  refs: string[],
): Promise<number> {
  if (!refs.length) return 0;
  const deleted = await db
    .delete(notebookSourceTable)
    .where(
      and(
        eq(notebookSourceTable.workspaceId, workspaceId),
        eq(notebookSourceTable.kind, kind),
        inArray(notebookSourceTable.ref, refs),
      ),
    )
    .returning({ id: notebookSourceTable.id });
  return deleted.length;
}
