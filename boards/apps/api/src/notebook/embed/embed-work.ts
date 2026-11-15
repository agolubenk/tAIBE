import { redact } from "@kaneo/redact";
import { and, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import db from "../../database";
import { notebookChunkTable } from "../../database/notebook-schema";
import { maskChunkEdges, textNear } from "../chunk/mask-chunk-edges";
import {
  leaseChunks,
  leasedChunkIds,
  releaseChunks,
  resolveQuery,
  takeQueries,
} from "./embed-queue";
import { parseEmbedding } from "./embedding-codec";

// Small chunk batches keep a waiting search query at most one batch away.
export const EMBED_CHUNK_BATCH = 8;
export const EMBED_RESULTS_MAX = 64;

export type EmbedWorkItem = {
  kind: "query" | "chunk";
  id: string;
  text: string;
};

export type EmbedResult = {
  kind: "query" | "chunk";
  id: string;
  embedding: string;
};

// TB-196: the embedding worker is a token caller and its model may run at an
// outside provider, so a chunk goes to it masked, also a secret cut at its
// edge (TB-203). Vectors embedded before this change stay until their chunk
// changes or the model does. The text is masked before the heading is
// glued to it: a heading that ends with a label ("Authorization: Bearer")
// took the first word of the text as its value, and the secret after the
// text's own label stayed open (Claude #388 B1).
const chunkPassage = (chunk: {
  heading: string;
  text: string;
  before: string | null;
  after: string | null;
}) => {
  const { text } = maskChunkEdges(
    chunk.text,
    chunk.before ?? "",
    chunk.after ?? "",
  );
  return redact(chunk.heading ? `${chunk.heading}\n\n${text}` : text).text;
};

// Search queries first: someone is waiting on them.
export async function claimEmbedWork(
  workspaceId: string,
  model: string,
): Promise<EmbedWorkItem[]> {
  const items: EmbedWorkItem[] = takeQueries(
    workspaceId,
    EMBED_CHUNK_BATCH,
  ).map((query) => ({ kind: "query", ...query }));
  const room = EMBED_CHUNK_BATCH - items.length;
  if (room <= 0) return items;
  const leased = leasedChunkIds(workspaceId);
  const claimed = db
    .select({
      id: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
      sourceId: notebookChunkTable.sourceId,
      ordinal: notebookChunkTable.ordinal,
    })
    .from(notebookChunkTable)
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        or(
          isNull(notebookChunkTable.embedding),
          ne(notebookChunkTable.embedModel, model),
        ),
        leased.length ? notInArray(notebookChunkTable.id, leased) : undefined,
      ),
    )
    .orderBy(notebookChunkTable.sourceId, notebookChunkTable.ordinal)
    .limit(room)
    .as("claimed");
  // The neighbours of the claimed rows only (textNear).
  const chunks = await db
    .select({
      id: claimed.id,
      heading: claimed.heading,
      text: claimed.text,
      before: textNear(-1, "claimed"),
      after: textNear(1, "claimed"),
    })
    .from(claimed)
    .orderBy(claimed.sourceId, claimed.ordinal);
  leaseChunks(
    workspaceId,
    chunks.map(({ id }) => id),
  );
  for (const chunk of chunks) {
    items.push({
      kind: "chunk",
      id: chunk.id,
      text: chunkPassage(chunk),
    });
  }
  return items;
}

// Unknown ids are not errors: a query may have timed out, a chunk may have
// been replaced by a newer sync while the worker was embedding it.
export async function saveEmbeddings(
  workspaceId: string,
  model: string,
  results: EmbedResult[],
): Promise<{ saved: number; rejected: number }> {
  let saved = 0;
  let rejected = 0;
  const chunks: { id: string; vector: Buffer }[] = [];
  for (const result of results) {
    const vector = parseEmbedding(result.embedding);
    if (!vector) {
      rejected++;
      continue;
    }
    if (result.kind === "query") {
      if (resolveQuery(workspaceId, result.id, vector)) saved++;
      continue;
    }
    chunks.push({ id: result.id, vector });
  }
  if (!chunks.length) return { saved, rejected };

  const embeddedAt = new Date();
  const updated = await db.transaction(async (tx) => {
    let count = 0;
    for (const chunk of chunks) {
      const rows = await tx
        .update(notebookChunkTable)
        .set({ embedding: chunk.vector, embedModel: model, embeddedAt })
        .where(
          and(
            eq(notebookChunkTable.id, chunk.id),
            eq(notebookChunkTable.workspaceId, workspaceId),
          ),
        )
        .returning({ id: notebookChunkTable.id });
      count += rows.length;
    }
    return count;
  });
  releaseChunks(
    workspaceId,
    chunks.map(({ id }) => id),
  );
  return { saved: saved + updated, rejected };
}
