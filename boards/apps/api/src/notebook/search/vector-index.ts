import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import db from "../../database";
import { notebookChunkTable } from "../../database/notebook-schema";
import { decodeEmbedding, dot, normalize } from "../embed/embedding-codec";

// One normalized matrix per workspace, rebuilt when the embedded set changes:
// 3k chunks of 768 dims are ~9 MB and a full scan is a few milliseconds.
// Budgets are in bytes, not rows: a 4096-dim model is five times wider than
// nomic's 768. One index holds up to ~10.9k chunks of 768 dims; the cache
// drops the least recently used workspaces past its total.
export const VECTOR_BYTES_MAX = 32 * 1024 * 1024;
export const CACHE_BYTES_MAX = 64 * 1024 * 1024;

export type VectorIndex = {
  stamp: string;
  dims: number;
  ids: string[];
  matrix: Float32Array;
};

const cache = new Map<string, VectorIndex>();

const cacheKey = (workspaceId: string, model: string) =>
  `${workspaceId}\u0000${model}`;

export async function loadVectorIndex(
  workspaceId: string,
  model: string,
  bytesMax = VECTOR_BYTES_MAX,
): Promise<VectorIndex | null> {
  const scope = and(
    eq(notebookChunkTable.workspaceId, workspaceId),
    eq(notebookChunkTable.embedModel, model),
    isNotNull(notebookChunkTable.embedding),
  );
  const [state] = await db
    .select({
      count: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${notebookChunkTable.embeddedAt})::text`,
      width: sql<number>`max(octet_length(${notebookChunkTable.embedding}))::int`,
    })
    .from(notebookChunkTable)
    .where(scope);
  if (!state?.count) return null;
  const stamp = `${state.count}:${state.latest}`;
  const key = cacheKey(workspaceId, model);
  const cached = cache.get(key);
  if (cached?.stamp === stamp) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  // TB-76. Past the budget the freshest chunks stay, so the oldest drop out
  // by a rule and not by the heap's order; /status shows how many are in.
  const rowsMax = vectorRowsMax(state.width, bytesMax);
  if (state.count > rowsMax) {
    console.warn(
      `notebook: the vector index of workspace ${workspaceId} holds ${rowsMax} of ${state.count} chunks (budget ${bytesMax} bytes)`,
    );
  }
  const rows = await db
    .select({
      id: notebookChunkTable.id,
      embedding: notebookChunkTable.embedding,
    })
    .from(notebookChunkTable)
    .where(scope)
    .orderBy(
      sql`${notebookChunkTable.embeddedAt} desc nulls last`,
      desc(notebookChunkTable.id),
    )
    .limit(rowsMax);
  const index = buildVectorIndex(stamp, rows);
  if (!index) return null;
  cache.delete(key);
  cache.set(key, index);
  evictOverBudget(cache, CACHE_BYTES_MAX);
  return index;
}

// The widest row decides, so a half-finished model switch cannot overrun.
export function vectorRowsMax(
  widthBytes: number,
  bytesMax = VECTOR_BYTES_MAX,
): number {
  return Math.max(1, Math.floor(bytesMax / Math.max(4, widthBytes)));
}

// How many embedded chunks meaning-based search holds (TB-76).
export function searchableChunks(embedded: number, widthBytes: number | null) {
  return embedded > 0 ? Math.min(embedded, vectorRowsMax(widthBytes ?? 0)) : 0;
}

// Oldest first (Map keeps insertion order); the newest index always stays.
export function evictOverBudget(
  indexes: Map<string, VectorIndex>,
  budgetBytes: number,
) {
  let total = 0;
  for (const index of indexes.values()) total += index.matrix.byteLength;
  for (const [key, index] of indexes) {
    if (total <= budgetBytes || indexes.size === 1) break;
    indexes.delete(key);
    total -= index.matrix.byteLength;
  }
}

// Rows of another width (a half-finished model switch) are left out.
export function buildVectorIndex(
  stamp: string,
  rows: { id: string; embedding: Buffer | null }[],
): VectorIndex | null {
  const first = rows.find((row) => row.embedding);
  if (!first?.embedding) return null;
  const dims = first.embedding.length / 4;
  const usable = rows.filter((row) => row.embedding?.length === dims * 4);
  const matrix = new Float32Array(usable.length * dims);
  usable.forEach((row, i) => {
    matrix.set(normalize(decodeEmbedding(row.embedding as Buffer)), i * dims);
  });
  return { stamp, dims, ids: usable.map(({ id }) => id), matrix };
}

export function nearestChunks(
  index: VectorIndex,
  query: Float32Array,
  k: number,
): { id: string; score: number }[] {
  if (query.length !== index.dims) return [];
  const normalized = normalize(query);
  const scored = index.ids.map((id, i) => ({
    id,
    score: dot(normalized, index.matrix, i * index.dims),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function clearVectorCacheForTests() {
  cache.clear();
}
