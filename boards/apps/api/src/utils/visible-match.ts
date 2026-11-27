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
  return visibleWords(text, [query])[0] ?? false;
}

/**
 * For each of `words`, whether it occurs in `text` outside every redact hit,
 * as `matchesVisibleText` does. Redact reads the text once for all words.
 */
export function visibleWords(
  text: string | null | undefined,
  words: readonly string[],
): boolean[] {
  if (!text) return words.map(() => false);
  const needles = words.map((word) => word.toLowerCase());
  // Most fields of a candidate row do not hold any word at all.
  const lower = text.toLowerCase();
  if (!needles.some((needle) => lower.includes(needle))) {
    return words.map(() => false);
  }
  const parts: string[] = [];
  let start = 0;
  for (const hit of redact(text).hits) {
    parts.push(text.slice(start, hit.start).toLowerCase());
    start = hit.end;
  }
  parts.push(text.slice(start).toLowerCase());
  return needles.map((needle) => parts.some((part) => part.includes(needle)));
}

export type ScoredField = readonly [
  text: string | null | undefined,
  score: number,
];

/**
 * The score of a row for the words of a query, as the relevance `CASE` of
 * global search reads it on the visible text (TB-162): the score of the
 * first field that holds every word, else `rest` if each word is in one of
 * the fields, else null. One word: the first field that holds it.
 */
export function visibleScore(
  words: readonly string[],
  fields: ReadonlyArray<ScoredField>,
  rest = 1,
): number | null {
  const seen = words.map(() => false);
  for (const [text, score] of fields) {
    const found = visibleWords(text, words);
    if (found.every(Boolean)) return score;
    found.forEach((isFound, index) => {
      if (isFound) seen[index] = true;
    });
  }
  return seen.every(Boolean) ? rest : null;
}
