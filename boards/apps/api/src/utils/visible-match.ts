import { redact } from "@kaneo/redact";

// TB-191: SQL finds rows by the stored text, but a caller with a token reads
// it masked (TB-143). If a row whose only match is inside a secret came back,
// that caller would learn that the secret holds the query, and could guess
// the secret one character at a time. For such a caller a match counts only
// in the text between redact hits: the text that it reads anyway.

/** A query with a marker could match only the masked view, which is not searched. */
export function isMarkerQuery(query: string): boolean {
  return query.toLowerCase().includes("[redacted:");
}

/**
 * Whether `query` occurs in `text` outside every redact hit, ignoring case
 * as `ilike` and `strpos(lower(…))` do. A match does not cross a hit, so the
 * text next to a secret cannot be joined to a part of it. `%` and `_` are
 * literal.
 */
export function matchesVisibleText(
  text: string | null | undefined,
  query: string,
): boolean {
  if (!text) return false;
  const needle = query.toLowerCase();
  // Most fields of a candidate row do not hold the query at all.
  if (!text.toLowerCase().includes(needle)) return false;
  let start = 0;
  for (const hit of redact(text).hits) {
    if (text.slice(start, hit.start).toLowerCase().includes(needle)) {
      return true;
    }
    start = hit.end;
  }
  return text.slice(start).toLowerCase().includes(needle);
}

export type ScoredField = readonly [
  text: string | null | undefined,
  score: number,
];

/** The score of the first field whose visible text holds the query, or null. */
export function visibleScore(
  query: string,
  fields: ReadonlyArray<ScoredField>,
): number | null {
  for (const [text, score] of fields) {
    if (matchesVisibleText(text, query)) return score;
  }
  return null;
}
