import { type RedactHit, redact } from "@kaneo/redact";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  const all = merged(hits);
  return { text: masked(text, all), hidden: all.length > 0 };
}

// The text of the chunk before (-1) or after (1) a chunk of
// notebookChunkTable in the same section of its source, or null. A subquery
// of the same statement, so the neighbours are of the same sync as the
// chunk; with ORDER BY and LIMIT it runs only for the rows returned.
export function textNear(step: -1 | 1) {
  const near = alias(
    notebookChunkTable,
    step < 0 ? "chunk_before" : "chunk_after",
  );
  return sql<string | null>`(SELECT ${near.text} FROM ${near}
    WHERE ${near.sourceId} = ${notebookChunkTable.sourceId}
      AND ${near.ordinal} = ${notebookChunkTable.ordinal} + ${sql.raw(String(step))}
      AND ${near.heading} = ${notebookChunkTable.heading})`;
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
function masked(text: string, hits: RedactHit[]): string {
  let result = "";
  let cursor = 0;
  for (const hit of hits) {
    result += `${text.slice(cursor, hit.start)}[REDACTED:${hit.kind}]`;
    cursor = hit.end;
  }
  return result + text.slice(cursor);
}
