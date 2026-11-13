import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  type NotebookSourceKind,
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";
import { ApiError } from "../../errors/api-error";
import { chunkMarkdown } from "../chunk/chunk-markdown";
import { notifyEmbedWork } from "../embed/embed-queue";
import type { SourceAuthor } from "./source-author";

export type SourceInput = {
  workspaceId: string;
  kind: NotebookSourceKind;
  ref: string;
  title: string;
  text: string;
  // Refuse a text that cuts into more chunks: a fetched page of tiny
  // sections would flood the embedding worker and the vector index.
  maxChunks?: number;
  // Written on the first insert only: a refresh keeps who added it (TB-115).
  addedBy?: SourceAuthor;
};

// Keeps one insert far under the Postgres limit of 65 535 parameters.
const INSERT_BATCH = 1000;

export type UpsertedSource = {
  sourceId: string;
  changed: boolean;
  chunks: number;
};

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Same text: only the title may move, chunks and their embeddings stay. New
// text: the chunks are cut again and wait for the worker to embed them.
export async function upsertSource(
  input: SourceInput,
): Promise<UpsertedSource> {
  const contentSha256 = sha256(input.text);
  const key = and(
    eq(notebookSourceTable.workspaceId, input.workspaceId),
    eq(notebookSourceTable.kind, input.kind),
    eq(notebookSourceTable.ref, input.ref),
  );
  const [existing] = await db
    .select({
      id: notebookSourceTable.id,
      sha: notebookSourceTable.contentSha256,
      title: notebookSourceTable.title,
    })
    .from(notebookSourceTable)
    .where(key);
  if (existing && existing.sha === contentSha256) {
    if (existing.title !== input.title) {
      await db
        .update(notebookSourceTable)
        .set({ title: input.title })
        .where(eq(notebookSourceTable.id, existing.id));
    }
    const chunks = await db.$count(
      notebookChunkTable,
      eq(notebookChunkTable.sourceId, existing.id),
    );
    return { sourceId: existing.id, changed: false, chunks };
  }

  const chunks = chunkMarkdown(input.text);
  if (input.maxChunks !== undefined && chunks.length > input.maxChunks) {
    throw new ApiError(413, {
      code: "SOURCE_TOO_MANY_CHUNKS",
      message: `The text cuts into ${chunks.length} chunks; the notebook takes at most ${input.maxChunks} from one source.`,
    });
  }
  const sourceId = await db.transaction(async (tx) => {
    const [source] = await tx
      .insert(notebookSourceTable)
      .values({
        workspaceId: input.workspaceId,
        kind: input.kind,
        ref: input.ref,
        title: input.title,
        contentSha256,
        chars: input.text.length,
        addedByKind: input.addedBy?.kind ?? null,
        addedBy: input.addedBy?.name ?? null,
      })
      .onConflictDoUpdate({
        target: [
          notebookSourceTable.workspaceId,
          notebookSourceTable.kind,
          notebookSourceTable.ref,
        ],
        set: {
          title: input.title,
          contentSha256,
          chars: input.text.length,
          updatedAt: sql`(now() AT TIME ZONE 'utc')`,
        },
      })
      .returning({ id: notebookSourceTable.id });
    if (!source) throw new Error("notebook source upsert returned no row");
    await tx
      .delete(notebookChunkTable)
      .where(eq(notebookChunkTable.sourceId, source.id));
    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      await tx.insert(notebookChunkTable).values(
        chunks.slice(start, start + INSERT_BATCH).map((chunk, index) => ({
          sourceId: source.id,
          workspaceId: input.workspaceId,
          ordinal: start + index,
          heading: chunk.heading,
          text: chunk.text,
        })),
      );
    }
    return source.id;
  });
  notifyEmbedWork(input.workspaceId);
  return { sourceId, changed: true, chunks: chunks.length };
}
