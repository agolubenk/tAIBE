import { type RedactHit, redact } from "@kaneo/redact";
import { type AnyColumn, getTableName, sql } from "drizzle-orm";
import { notebookChunkTable } from "../../database/notebook-schema";

// TB-203: hardSplit cuts a long paragraph every CHUNK_MAX_CHARS characters,
// maybe inside a secret, and redact does not know a secret without its start
// or its name (`DB_P` | `ASSWORD=…`, `ghp_…` cut in two). So a chunk is read
// with the chunks before and after it: redact reads the three glued, and
// every hit that touches the chunk is masked in it, together with the
// chunk's own hits. The glue is empty, as a cut inside a word was, and then
// a space: a chunk is trimmed, so a cut at whitespace (`Bearer ` | `<token>`)
// glued without one would read `Bearer<token>`. A glue where a blank line
// was can add a mask; it cannot take one away.
const GLUES = ["", " "];

export function maskChunkEdges(
  text: string,
  before = "",
  after = "",
): { text: string; hidden: boolean } {
  const all = edgeHits(text, before, after);
  return { text: masked(text, all), hidden: all.length > 0 };
}

// TB-196 (boards #388 N1, coord 10:56): the passage of the embedding worker
// is the heading and the text glued by a blank line. It masks every
// character that one of two readings masks: the glue read whole (#388 before
// B1), and the glue read again over the text masked first, with its
// neighbours (Claude #388 B1). On the redact of #388 each reading alone
// opened a value that the other masked. Without a heading the passage is the
// text, and it is read again too: the passage before TB-203 was
// redact(redact(text).text), and a marker lifts the `-` lookaround of a
// detector (a token glued to a PEM block, Claude lens #400 B2).
export function maskPassage(
  heading: string,
  text: string,
  before = "",
  after = "",
): string {
  const own = edgeHits(text, before, after);
  const from = heading ? heading.length + 2 : 0;
  const glued = (body: string) => (heading ? `${heading}\n\n${body}` : body);
  const passage = glued(text);
  // Without a heading the passage is the text: its hits are in `own`.
  const whole = heading ? redact(passage).hits : [];
  const again = redact(glued(masked(text, own))).hits.map((hit) => ({
    kind: hit.kind,
    start: inPassage(hit.start, from, own).start,
    end: inPassage(hit.end - 1, from, own).end,
  }));
  const shifted = own.map((hit) => ({
    ...hit,
    start: hit.start + from,
    end: hit.end + from,
  }));
  return masked(passage, merged([...whole, ...shifted, ...again]));
}

// The chunk's own hits and the hits of its glue with the neighbours that
// touch it, merged, in its offsets.
function edgeHits(text: string, before: string, after: string): RedactHit[] {
  const hits = redact(text).hits;
  if (before || after) {
    for (const glue of GLUES) {
      hits.push(
        ...touching(
          before ? `${before}${glue}` : "",
          text,
          after ? `${glue}${after}` : "",
        ),
      );
    }
  }
  return merged(hits);
}

// The passage characters that the character `at` of the heading glued to
// the masked text stands for: a marker stands for the whole hit it
// replaced. `hits` are the merged hits of the text.
function inPassage(
  at: number,
  from: number,
  hits: RedactHit[],
): { start: number; end: number } {
  if (at < from) return { start: at, end: at + 1 };
  const index = at - from;
  let inMasked = 0;
  let inText = 0;
  for (const hit of hits) {
    const plain = hit.start - inText;
    if (index < inMasked + plain) {
      const char = from + inText + index - inMasked;
      return { start: char, end: char + 1 };
    }
    inMasked += plain + marker(hit.kind).length;
    if (index < inMasked) {
      return { start: from + hit.start, end: from + hit.end };
    }
    inText = hit.end;
  }
  const char = from + inText + index - inMasked;
  return { start: char, end: char + 1 };
}

// The text of the chunk before (-1) or after (1) a chunk in the same
// section of its source, or null. `chunk` names the outer relation with the
// chunk's `source_id`, `ordinal` and `heading`. A subquery of the same
// statement, so the neighbours are of the same sync as the chunk. Every name
// is written in full: drizzle prints an alias without its table and leaves
// columns of a one-table select unqualified, and inside the subquery those
// would name the neighbour. Postgres runs a subquery of the select list
// before ORDER BY and LIMIT of the same level (EXPLAIN VERBOSE, PG 16):
// a ranked or limited query reads the neighbours one level up.
export function textNear(
  step: -1 | 1,
  chunk: string = getTableName(notebookChunkTable),
) {
  const near = step < 0 ? "chunk_before" : "chunk_after";
  const column = (of: string, { name }: AnyColumn) =>
    sql`${sql.identifier(of)}.${sql.identifier(name)}`;
  const { heading, ordinal, sourceId, text } = notebookChunkTable;
  return sql<string | null>`(SELECT ${column(near, text)}
    FROM ${notebookChunkTable} AS ${sql.identifier(near)}
    WHERE ${column(near, sourceId)} = ${column(chunk, sourceId)}
      AND ${column(near, ordinal)} = ${column(chunk, ordinal)} + ${sql.raw(String(step))}
      AND ${column(near, heading)} = ${column(chunk, heading)})`;
}

// Hits of the glued text that touch `text`, in its offsets.
function touching(before: string, text: string, after: string): RedactHit[] {
  const from = before.length;
  const to = from + text.length;
  return redact(`${before}${text}${after}`).hits.flatMap((hit) =>
    hit.end > from && hit.start < to
      ? [
          {
            kind: hit.kind,
            start: Math.max(hit.start, from) - from,
            end: Math.min(hit.end, to) - from,
          },
        ]
      : [],
  );
}

// Overlapping hits become one; the first one names the kind.
function merged(hits: RedactHit[]): RedactHit[] {
  const out: RedactHit[] = [];
  for (const hit of [...hits].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const last = out[out.length - 1];
    if (last && hit.start < last.end) {
      last.end = Math.max(last.end, hit.end);
      continue;
    }
    out.push({ ...hit });
  }
  return out;
}

// The marker format of redact.
const marker = (kind: string) => `[REDACTED:${kind}]`;

function masked(text: string, hits: RedactHit[]): string {
  let result = "";
  let cursor = 0;
  for (const hit of hits) {
    result += `${text.slice(cursor, hit.start)}${marker(hit.kind)}`;
    cursor = hit.end;
  }
  return result + text.slice(cursor);
}
