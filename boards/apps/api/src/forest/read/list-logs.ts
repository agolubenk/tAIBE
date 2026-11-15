import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import db from "../../database";
import { timberLogTable } from "../../database/forest-schema";
import { isMarkerQuery, matchesVisibleText } from "../../utils/visible-match";
import { decodeCursor, encodeCursor, pageSize } from "./page-cursor";

function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// Logs are read-only history; the list carries no history or fields, only
// what is needed to pick a log (open it with getLog).
//
// TB-196: a caller with a token reads a log masked (TB-143), so for it a
// match counts only in the visible text of searchText, as in global search
// (TB-191): a log found by a part of a secret would tell that the secret
// holds the query. The page is the candidates SQL found; those with no
// visible match are left out, so the page may hold fewer than `take` logs
// and still have a nextCursor.
export async function listLogs({
  workspaceId,
  query,
  cursor,
  take,
  tokenCaller = false,
}: {
  workspaceId: string;
  query?: string;
  cursor?: string;
  take?: number;
  tokenCaller?: boolean;
}) {
  const limit = pageSize(take);
  const after = decodeCursor(cursor);
  const search = query?.trim();
  const visibleOnly = tokenCaller && Boolean(search);
  if (visibleOnly && search && isMarkerQuery(search)) {
    return { items: [], nextCursor: null };
  }
  const rows = await db
    .select({
      id: timberLogTable.id,
      title: timberLogTable.title,
      taskNumber: timberLogTable.taskNumber,
      finalStatus: timberLogTable.finalStatus,
      priority: timberLogTable.priority,
      sourceProjectId: timberLogTable.sourceProjectId,
      sourceProjectName: timberLogTable.sourceProjectName,
      fellingId: timberLogTable.fellingId,
      felledAt: timberLogTable.felledAt,
      searchText: visibleOnly ? timberLogTable.searchText : sql<string>`''`,
    })
    .from(timberLogTable)
    .where(
      and(
        eq(timberLogTable.workspaceId, workspaceId),
        search
          ? ilike(timberLogTable.searchText, likePattern(search))
          : undefined,
        after
          ? or(
              lt(timberLogTable.felledAt, after.at),
              and(
                eq(timberLogTable.felledAt, after.at),
                lt(timberLogTable.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(timberLogTable.felledAt), desc(timberLogTable.id))
    .limit(limit + 1);

  const scanned = rows.slice(0, limit);
  const last = scanned.at(-1);
  const items = scanned
    .filter(
      (row) =>
        !visibleOnly || !search || matchesVisibleText(row.searchText, search),
    )
    .map(({ searchText: _searchText, ...item }) => item);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ at: last.felledAt, id: last.id })
        : null,
  };
}
