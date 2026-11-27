import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import { MAX_QUERY_WORDS, queryWords, wordConditions } from "./query-words";

const dialect = new PgDialect();
const title = sql.identifier("title");
const description = sql.identifier("description");

describe("queryWords (TB-162)", () => {
  it("splits on white space, lowercases and drops repeats", () => {
    expect(queryWords("  Postgres\tприложение\nPOSTGRES ")).toEqual([
      "postgres",
      "приложение",
    ]);
  });

  it("keeps one word as it is", () => {
    expect(queryWords("t_boards")).toEqual(["t_boards"]);
  });

  it("keeps the first words only", () => {
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`);
    expect(queryWords(words.join(" "))).toEqual(
      words.slice(0, MAX_QUERY_WORDS),
    );
  });

  it("keeps a query of white space only as one word", () => {
    expect(queryWords("   ")).toEqual(["   "]);
  });
});

describe("wordConditions (TB-162)", () => {
  it("needs each word in one of the fields, each word as a literal pattern", () => {
    const match = wordConditions(["t_boards", "50%"]);
    const query = dialect.sqlToQuery(match.inAnyField([title, description]));
    expect(query.sql).toBe(
      '(("title" ilike $1 or "description" ilike $2) and ("title" ilike $3 or "description" ilike $4))',
    );
    expect(query.params).toEqual([
      "%t\\_boards%",
      "%t\\_boards%",
      "%50\\%%",
      "%50\\%%",
    ]);
  });

  it("needs all words in one field for a branch of the score", () => {
    const query = dialect.sqlToQuery(
      wordConditions(["a\\b", "c"]).allIn(title),
    );
    expect(query.sql).toBe('("title" ilike $1 and "title" ilike $2)');
    expect(query.params).toEqual(["%a\\\\b%", "%c%"]);
  });
});
