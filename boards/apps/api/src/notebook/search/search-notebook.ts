import { redact } from "@kaneo/redact";
import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../database";
import {
  type NotebookSourceKind,
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";
import { isWorkerOnline, requestQueryEmbedding } from "../embed/embed-queue";
import { decodeEmbedding } from "../embed/embedding-codec";
import { notebookEmbedModel } from "../../notebook-model/effective-notebook-model";
import { maskChunkEdges, textNear } from "../chunk/mask-chunk-edges";
import { fuseRanks, type RankedList } from "./fuse-ranks";
import { loadVectorIndex, nearestChunks } from "./vector-index";

const CANDIDATES = 20;
// TB-196: keyword candidates a token caller's search reads and ranks by the
// text it reads. Hidden chunks are rare (27 of 6612 in the synced docs);
// the cap stops planted secret chunks from making one search read the
// whole corpus.
const KEYWORD_SCAN_MAX = 200;
// A marker of redact; in the checked text it is a space (backend #388 B1).
const MARKER = /\[REDACTED:[a-z0-9_]+\]/g;
// Longer than one worker batch, short enough that a stuck worker costs the
// reader a few seconds of keyword-only results, not a hang.
export const QUERY_EMBED_WAIT_MS = 4_000;

export type SearchMode = "hybrid" | "keyword";
type MatchedBy = "vector" | "keyword";

export type NotebookHit = {
  chunkId: string;
  source: { kind: NotebookSourceKind; ref: string; title: string };
  heading: string;
  text: string;
  score: number;
  matchedBy: MatchedBy[];
};

export async function searchNotebook(input: {
  workspaceId: string;
  query: string;
  limit: number;
  mode: SearchMode;
  // A caller that already read the settings passes the model along.
  embedModel?: string;
  // A caller with a token (API key, agent key, MCP session), TB-196.
  tokenCaller?: boolean;
  // The text leaves the board, for a caller with a token (the default) or
  // for a model: its secrets are masked, also one cut at a chunk edge
  // (TB-203).
  masked?: boolean;
}): Promise<{ mode: SearchMode; results: NotebookHit[] }> {
  const wantVectors =
    input.mode === "hybrid" && isWorkerOnline(input.workspaceId);
  const [keywordIds, vectorIds] = await Promise.all([
    input.tokenCaller
      ? visibleKeywordCandidates(input.workspaceId, input.query)
      : keywordCandidates(input.workspaceId, input.query),
    wantVectors
      ? vectorCandidates(input.workspaceId, input.query, input.embedModel)
      : Promise.resolve(null),
  ]);
  const lists: RankedList<MatchedBy>[] = [{ by: "keyword", ids: keywordIds }];
  if (vectorIds) lists.unshift({ by: "vector", ids: vectorIds });
  const fused = fuseRanks(lists).slice(0, input.limit);
  const rows = await loadHits(
    input.workspaceId,
    fused.map(({ id }) => id),
    input.masked ?? Boolean(input.tokenCaller),
  );
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  const results = fused.flatMap((hit) => {
    const row = byId.get(hit.id);
    return row ? [{ ...row, score: hit.score, matchedBy: hit.matchedBy }] : [];
  });
  return { mode: vectorIds ? "hybrid" : "keyword", results };
}

// TB-196: a caller with a token reads a chunk masked (the route masks the
// response, TB-143). For it a keyword candidate stays only if the query
// matches the text that it reads: the stored tsvector for a chunk with no
// secret, the tsvector of the masked text for a chunk with one. The others
// leave the list before the ranks are fused: else the hit, its `matchedBy`
// or the ranks of the hits after it would tell that a secret holds a word
// (backend lens #388 B2).
//
// A word with `-` before it must be absent, and SQL decides that on the
// stored tsvector, which holds the secret: `staging -<guess>` would drop a
// chunk only if the guess is in its secret (Claude #388 B1). So the
// candidates come from the indexable part of the query (`querytree`, the
// query without its negations), and then the whole query is checked as
// above. A query with nothing indexable (`-word`, `a or -b`) cannot be
// judged on a hidden chunk: such chunks leave the list.
//
// The rank is of the same text, and the first 20 are taken only after all
// candidates up to the cap are ranked: with the stored rank, `аренда or
// <guess>` would put a chunk whose secret holds the guess first, and with
// only the first ranks read, a hidden chunk would push a visible one out
// (release lens #388).
//
// The masked text must hold no word that the stored text has not: else
// `redacted or <guess>` passes the check by the marker (`redact`, `password`,
// `assign`) only for a chunk that the guess made a candidate (backend lens
// #388 B1). So a marker is a space, and the checked tsvector keeps only the
// lexemes of the stored one: a chunk that can pass the check is already a
// candidate.
async function visibleKeywordCandidates(workspaceId: string, query: string) {
  const rows = await indexableCandidates(workspaceId, query);
  if (rows.length > KEYWORD_SCAN_MAX) {
    // The query is not logged: it can hold a guess at a secret.
    console.warn("Notebook search stopped at the scan cap of keyword hits", {
      workspaceId,
      rows: KEYWORD_SCAN_MAX,
    });
  }
  return visibleRanked(rows.slice(0, KEYWORD_SCAN_MAX), query);
}

type Candidate = Awaited<ReturnType<typeof indexableCandidates>>[number];

// The first 20 rows that the whole query matches in the text the caller
// reads, by the rank in that text, then by id.
async function visibleRanked(rows: Candidate[], query: string) {
  const checked = rows.flatMap(
    (row): { id: string; masked: string | null }[] => {
      // The text as the caller reads it: a secret cut at a chunk edge is
      // masked too (TB-203), and the route masks each field once more.
      const edges = maskChunkEdges(row.text, row.before ?? "", row.after ?? "");
      const heading = redact(row.heading);
      if (!edges.hidden && !heading.hits.length) {
        return [{ id: row.id, masked: null }];
      }
      if (row.negationsOnly) return [];
      const seen = `${heading.text} ${redact(edges.text).text}`;
      return [{ id: row.id, masked: seen.replace(MARKER, " ") }];
    },
  );
  if (!checked.length) return [];
  const result = await db.execute<{ id: string }>(sql`
    SELECT t.id
    FROM (VALUES ${sql.join(
      checked.map((row) => sql`(${row.id}, ${row.masked}::text)`),
      sql`, `,
    )}) AS t(id, masked)
    JOIN ${notebookChunkTable} c ON c.id = t.id
    CROSS JOIN LATERAL (
      SELECT to_tsvector('russian', t.masked) AS raw
    ) m
    CROSS JOIN LATERAL (
      SELECT CASE WHEN t.masked IS NULL THEN c.search
        ELSE ts_delete(m.raw, ARRAY(
          SELECT unnest(tsvector_to_array(m.raw))
          EXCEPT SELECT unnest(tsvector_to_array(c.search))))
      END AS seen
    ) v
    CROSS JOIN LATERAL (
      SELECT websearch_to_tsquery('russian', ${query}) AS q
    ) w
    WHERE v.seen @@ w.q
    ORDER BY ts_rank(v.seen, w.q) DESC, t.id
    LIMIT ${CANDIDATES}
  `);
  return result.rows.map((row) => row.id);
}

// A token caller's candidates with their text, one row past the cap.
// `querytree` is `T` when no part of the query can be looked up (only
// negations).
async function indexableCandidates(workspaceId: string, query: string) {
  const full = sql`websearch_to_tsquery('russian', ${query})`;
  const indexable = sql`(CASE WHEN querytree(${full}) = 'T' THEN ${full} ELSE querytree(${full})::tsquery END)`;
  return db
    .select({
      id: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
      before: textNear(-1),
      after: textNear(1),
      negationsOnly: sql<boolean>`querytree(${full}) = 'T'`,
    })
    .from(notebookChunkTable)
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        sql`${notebookChunkTable.search} @@ ${indexable}`,
      ),
    )
    .orderBy(
      sql`ts_rank(${notebookChunkTable.search}, ${indexable}) desc`,
      notebookChunkTable.id,
    )
    .limit(KEYWORD_SCAN_MAX + 1);
}

async function keywordCandidates(workspaceId: string, query: string) {
  const tsquery = sql`websearch_to_tsquery('russian', ${query})`;
  const rows = await db
    .select({ id: notebookChunkTable.id })
    .from(notebookChunkTable)
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        sql`${notebookChunkTable.search} @@ ${tsquery}`,
      ),
    )
    .orderBy(
      sql`ts_rank(${notebookChunkTable.search}, ${tsquery}) desc`,
      notebookChunkTable.id,
    )
    .limit(CANDIDATES);
  return rows.map(({ id }) => id);
}

// Null means no vector ranking this time; the caller says so in `mode`.
async function vectorCandidates(
  workspaceId: string,
  query: string,
  embedModel?: string,
) {
  const vector = await requestQueryEmbedding(
    workspaceId,
    query,
    QUERY_EMBED_WAIT_MS,
  );
  if (!vector) return null;
  const index = await loadVectorIndex(
    workspaceId,
    embedModel ?? (await notebookEmbedModel()),
  );
  if (!index) return null;
  return nearestChunks(index, decodeEmbedding(vector), CANDIDATES).map(
    ({ id }) => id,
  );
}

async function loadHits(workspaceId: string, ids: string[], masked: boolean) {
  if (!ids.length) return [];
  const near = (step: -1 | 1) =>
    masked ? textNear(step) : sql<string | null>`null`;
  const rows = await db
    .select({
      chunkId: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
      before: near(-1),
      after: near(1),
      kind: notebookSourceTable.kind,
      ref: notebookSourceTable.ref,
      title: notebookSourceTable.title,
    })
    .from(notebookChunkTable)
    .innerJoin(
      notebookSourceTable,
      eq(notebookSourceTable.id, notebookChunkTable.sourceId),
    )
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        inArray(notebookChunkTable.id, ids),
      ),
    );
  return rows.map(({ kind, ref, title, before, after, ...row }) => ({
    ...row,
    text: masked
      ? maskChunkEdges(row.text, before ?? "", after ?? "").text
      : row.text,
    source: { kind, ref, title },
  }));
}
