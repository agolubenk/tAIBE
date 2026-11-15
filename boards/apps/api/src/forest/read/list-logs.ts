import { and, desc, eq, ilike, inArray, lt, or } from "drizzle-orm";
import db from "../../database";
import { timberLogTable } from "../../database/forest-schema";
import { isMarkerQuery, matchesVisibleText } from "../../utils/visible-match";
import {
  decodeCursor,
  encodeCursor,
  PAGE_MAX,
  type PageCursor,
  pageSize,
} from "./page-cursor";

function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const listColumns = {
  id: timberLogTable.id,
  title: timberLogTable.title,
  taskNumber: timberLogTable.taskNumber,
  finalStatus: timberLogTable.finalStatus,
  priority: timberLogTable.priority,
  sourceProjectId: timberLogTable.sourceProjectId,
  sourceProjectName: timberLogTable.sourceProjectName,
  fellingId: timberLogTable.fellingId,
  felledAt: timberLogTable.felledAt,
};

function inWorkspaceAfter(workspaceId: string, after: PageCursor | null) {
  return and(
    eq(timberLogTable.workspaceId, workspaceId),
    after
      ? or(
          lt(timberLogTable.felledAt, after.at),
          and(
            eq(timberLogTable.felledAt, after.at),
            lt(timberLogTable.id, after.id),
          ),
        )
      : undefined,
  );
}

// Logs are read-only history; the list carries no history or fields, only
// what is needed to pick a log (open it with getLog).
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
  if (tokenCaller && search) {
    return listVisibleLogs(workspaceId, search, after, limit);
  }
  const rows = await db
    .select(listColumns)
    .from(timberLogTable)
    .where(
      and(
        inWorkspaceAfter(workspaceId, after),
        search
          ? ilike(timberLogTable.searchText, likePattern(search))
          : undefined,
      ),
    )
    .orderBy(desc(timberLogTable.felledAt), desc(timberLogTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ at: last.felledAt, id: last.id })
        : null,
  };
}

// TB-196: a caller with a token reads a log masked (TB-143), so for it a
// match counts only in the visible text of searchText (TB-191). The page is
// a window of logs in list order, not cut by matches (as TB-191's deferred
// descriptions): it ends at the `limit`-th visible match or at the window's
// end, so the cursor never names a log whose only match is inside a secret.
// A page can hold fewer logs than `limit`, or none, and still have a cursor.
async function listVisibleLogs(
  workspaceId: string,
  search: string,
  after: PageCursor | null,
  limit: number,
) {
  if (isMarkerQuery(search)) return { items: [], nextCursor: null };
  const window = await db
    .select(listColumns)
    .from(timberLogTable)
    .where(inWorkspaceAfter(workspaceId, after))
    .orderBy(desc(timberLogTable.felledAt), desc(timberLogTable.id))
    .limit(PAGE_MAX + 1);
  const scanned = window.slice(0, PAGE_MAX);
  // Only logs whose stored text holds the query are loaded and masked.
  const texts = scanned.length
    ? await db
        .select({
          id: timberLogTable.id,
          searchText: timberLogTable.searchText,
        })
        .from(timberLogTable)
        .where(
          and(
            inArray(
              timberLogTable.id,
              scanned.map((row) => row.id),
            ),
            ilike(timberLogTable.searchText, likePattern(search)),
          ),
        )
    : [];
  const visible = new Set(
    texts
      .filter((row) => matchesVisibleText(row.searchText, search))
      .map((row) => row.id),
  );
  const items: typeof scanned = [];
  let end = scanned.length;
  for (const [index, row] of scanned.entries()) {
    if (!visible.has(row.id)) continue;
    items.push(row);
    if (items.length === limit) {
      end = index + 1;
      break;
    }
  }
  const last = scanned[end - 1];
  const more = end < scanned.length || window.length > PAGE_MAX;
  return {
    items,
    nextCursor:
      more && last ? encodeCursor({ at: last.felledAt, id: last.id }) : null,
  };
}
