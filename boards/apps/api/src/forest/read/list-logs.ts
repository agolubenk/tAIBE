import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import db from "../../database";
import { timberLogTable } from "../../database/forest-schema";
import { maskedMatchPage } from "../../task/masked-match-page";
import { isMarkerQuery, matchesVisibleText } from "../../utils/visible-match";
import { SEARCH_TEXT_CHARS, searchFields } from "../fell/build-log";
import {
  decodeCursor,
  encodeCursor,
  PAGE_MAX,
  type PageCursor,
  pageSize,
} from "./page-cursor";
import { searchedParts } from "./searched-parts";

// The comments of a log's history up to the cut of its searchText: those
// that start past SEARCH_TEXT_CHARS of it are not read (up to 500 comments
// of 4000 characters). A kept comment is not longer than the searched one,
// and `length` counts no more than JavaScript does, so every comment that
// searchText holds is in the list.
const searchedContents = sql<(string | null)[]>`ARRAY(
  SELECT h.content FROM (
    SELECT e.n, e.item->>'content' AS content,
      sum(coalesce(nullif(length(e.item->>'content'), 0) + 1, 0))
        OVER (ORDER BY e.n) AS upto
    FROM jsonb_array_elements(${timberLogTable.history})
      WITH ORDINALITY AS e(item, n)
  ) h
  WHERE h.upto - coalesce(length(h.content), 0) <= ${SEARCH_TEXT_CHARS}
  ORDER BY h.n
)`;

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
// The window is cut by row count and by 1 MiB of stored text, as TB-191
// (backend lens #388, N2): a log's searchText is up to 100 000 characters.
async function listVisibleLogs(
  workspaceId: string,
  search: string,
  after: PageCursor | null,
  limit: number,
) {
  if (isMarkerQuery(search)) return { items: [], nextCursor: null };
  const window = await db
    .select({
      ...listColumns,
      bytes: sql<number>`octet_length(${timberLogTable.searchText})`,
    })
    .from(timberLogTable)
    .where(inWorkspaceAfter(workspaceId, after))
    .orderBy(desc(timberLogTable.felledAt), desc(timberLogTable.id))
    .limit(PAGE_MAX + 1);
  const scanned = maskedMatchPage(window, PAGE_MAX);
  // Only logs whose stored text holds the query are loaded and masked.
  const texts = scanned.length
    ? await db
        .select({
          id: timberLogTable.id,
          searchText: timberLogTable.searchText,
          title: timberLogTable.title,
          description: sql<
            string | null
          >`left(${timberLogTable.description}, ${SEARCH_TEXT_CHARS})`,
          contents: searchedContents,
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
      .filter((row) =>
        searchedParts(
          row.searchText,
          searchFields(row.title, row.description, row.contents),
        ).some((part) => matchesVisibleText(part, search)),
      )
      .map((row) => row.id),
  );
  const items: (typeof scanned)[number][] = [];
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
  const more = end < scanned.length || window.length > scanned.length;
  return {
    items: items.map(({ bytes: _bytes, ...row }) => row),
    nextCursor:
      more && last ? encodeCursor({ at: last.felledAt, id: last.id }) : null,
  };
}
