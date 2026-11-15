import {
  type AnyColumn,
  desc,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { type ScoredField, visibleScore } from "../../utils/visible-match";

/**
 * TB-191: how many candidate rows of one result type a caller with a token
 * scans. They come newest first, not by the stored score: that score would
 * rank a row by a match inside a secret and push a visible match off the
 * page. With fewer candidates than this, the page is the owner's ranking
 * applied to the text that the caller reads.
 */
export const TOKEN_CALLER_SCAN_ROWS = 200;

/**
 * TB-191: the stored text of the candidates of one result type that a caller
 * with a token scans, newest first. Older candidates come back without their
 * text and are not scanned, so memory and redact time stay bounded: redact
 * reads 1 MiB of text dense with secrets in about 25 ms.
 */
export const TOKEN_CALLER_SCAN_BYTES = 1024 * 1024;

export type VisibleRow = {
  createdAt: Date;
  relevanceScore: number;
  fits: boolean;
};
export type VisibleFields<T> = (row: T) => ReadonlyArray<ScoredField>;

/**
 * Candidates scored again on their visible text (`fields` in the order and
 * with the scores of the SQL `CASE`), without those that match only inside
 * a secret; the `limit` best, by score, then by createdAt descending.
 */
export function rankVisible<T extends VisibleRow>(
  rows: T[],
  query: string,
  limit: number,
  fields: VisibleFields<T>,
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const relevanceScore = visibleScore(query, fields(row));
    if (relevanceScore !== null) kept.push({ ...row, relevanceScore });
  }
  return kept
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, limit);
}

/**
 * How one result type of global search is read: how many rows, in which
 * order, and which of them stay. The owner keeps the SQL ranking and limit.
 */
export function searchWindow(
  tokenCaller: boolean,
  query: string,
  limit: number,
) {
  return {
    rows: tokenCaller ? TOKEN_CALLER_SCAN_ROWS : limit,
    order: (score: SQL, createdAt: AnyColumn) =>
      tokenCaller ? [desc(createdAt)] : [desc(score), desc(createdAt)],
    /**
     * `fits`: the candidate, with all newer candidates that fit, holds no
     * more than the scan budget in `sizes`. A candidate bigger than the
     * budget alone does not fit and is not counted, so older ones still can.
     * `text`: a field, null for a candidate that does not fit. For the owner
     * both leave the query as it was.
     */
    budget: (createdAt: AnyColumn, sizes: SQLWrapper[]) => {
      const size = sql`(${sql.join(
        sizes.map((field) => sql`coalesce(octet_length(${field}), 0)`),
        sql` + `,
      )})`;
      const max = TOKEN_CALLER_SCAN_BYTES;
      const fits = tokenCaller
        ? sql<boolean>`(${size} <= ${max} and sum(case when ${size} <= ${max} then ${size} else 0 end) over (order by ${createdAt} desc rows unbounded preceding) <= ${max})`
        : sql<boolean>`true`;
      const text = <T>(field: SQLWrapper) =>
        tokenCaller
          ? sql<T | null>`case when ${fits} then ${field} end`
          : sql<T | null>`${field}`;
      return { fits, text };
    },
    pick: <T extends VisibleRow>(found: T[], fields: VisibleFields<T>) =>
      tokenCaller
        ? rankVisible(
            found.filter((row) => row.fits),
            query,
            limit,
            fields,
          )
        : found,
  };
}
