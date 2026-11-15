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
import { fuseRanks, type RankedList } from "./fuse-ranks";
import { matchesVisibleText } from "../../utils/visible-match";
import { loadVectorIndex, nearestChunks } from "./vector-index";

const CANDIDATES = 20;
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
}): Promise<{ mode: SearchMode; results: NotebookHit[] }> {
  const wantVectors =
    input.mode === "hybrid" && isWorkerOnline(input.workspaceId);
  const [keywordIds, vectorIds] = await Promise.all([
    keywordCandidates(input.workspaceId, input.query).then((ids) =>
      input.tokenCaller ? visibleKeywordIds(ids, input.query) : ids,
    ),
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
  );
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  const results = fused.flatMap((hit) => {
    const row = byId.get(hit.id);
    return row ? [{ ...row, score: hit.score, matchedBy: hit.matchedBy }] : [];
  });
  return { mode: vectorIds ? "hybrid" : "keyword", results };
}

// TB-196: a caller with a token reads a chunk masked (the route masks the
// response, TB-143). For it a keyword candidate that holds a secret stays
// only if each query word is in its visible text, and the others leave the
// list before the ranks are fused: else the hit, its `matchedBy` or the
// ranks of the hits after it would tell that a secret holds the word
// (backend lens #388 B2). Chunks with no secret keep the stemmed match (the
// stored tsvector finds `ключ` for `ключами`, a substring test would not).
async function visibleKeywordIds(ids: string[], query: string) {
  if (!ids.length) return ids;
  const rows = await db
    .select({
      id: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
    })
    .from(notebookChunkTable)
    .where(inArray(notebookChunkTable.id, ids));
  const visible = new Set(
    rows.filter((row) => keywordHitVisible(row, query)).map((row) => row.id),
  );
  return ids.filter((id) => visible.has(id));
}

function keywordHitVisible(
  row: { heading: string; text: string },
  query: string,
): boolean {
  const passage = `${row.heading}\n${row.text}`;
  if (!redact(passage).hits.length) return true;
  return queryWords(query).every((word) => matchesVisibleText(passage, word));
}

// The words `websearch_to_tsquery` must find: no quotes, no `or`, and no
// word with `-` before it (that one must be absent).
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && word !== "or" && !word.startsWith("-"))
    .map((word) => word.replace(/^"+|"+$/g, ""))
    .filter(Boolean);
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
    .orderBy(sql`ts_rank(${notebookChunkTable.search}, ${tsquery}) desc`)
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

async function loadHits(workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({
      chunkId: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
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
  return rows.map(({ kind, ref, title, ...row }) => ({
    ...row,
    source: { kind, ref, title },
  }));
}
