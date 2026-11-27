import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { escapeLikePattern } from "./like-pattern";

/**
 * TB-162: global search finds a row when each word of the query is in one of
 * its fields, in any order. Before, the whole query was one substring, so a
 * duplicate check with two key words that are not next to each other found
 * nothing. Only the first words count; the rest of the query is not searched.
 */
export const MAX_QUERY_WORDS = 8;

/**
 * The words of a query split on white space, lowercased, without repeats, at
 * most `MAX_QUERY_WORDS`. A query of white space only is one word, as before.
 */
export function queryWords(query: string): string[] {
  const lower = query.toLowerCase();
  const words = [...new Set(lower.split(/\s+/).filter(Boolean))];
  return words.length > 0 ? words.slice(0, MAX_QUERY_WORDS) : [lower];
}

const joined = (parts: SQL[], operator: "and" | "or") =>
  sql`(${sql.join(parts, sql.raw(` ${operator} `))})`;

/**
 * SQL conditions for the words of a query. `_`, `%` and `\` in a word are
 * literal characters, not LIKE wildcards.
 */
export function wordConditions(words: readonly string[]) {
  const patterns = words.map((word) => `%${escapeLikePattern(word)}%`);
  return {
    /** Each word is in one of `fields`: the filter of a result type. */
    inAnyField: (fields: readonly SQLWrapper[]) =>
      joined(
        patterns.map((pattern) =>
          joined(
            fields.map((field) => sql`${field} ilike ${pattern}`),
            "or",
          ),
        ),
        "and",
      ),
    /** All words are in `field`: a branch of the relevance `CASE`. */
    allIn: (field: SQLWrapper) =>
      joined(
        patterns.map((pattern) => sql`${field} ilike ${pattern}`),
        "and",
      ),
  };
}
