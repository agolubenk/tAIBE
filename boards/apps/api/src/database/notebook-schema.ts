// t-boards notebook (spec R-050…R-053): sources cut into chunks, searched by
// words and, when the Mac embedding worker is online, by meaning. Embeddings
// are float32 vectors packed into bytea: the corpus is a few thousand chunks,
// so cosine runs in the API process and Postgres needs no extension.
import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { userTable, workspaceTable } from "./schema";

const utcNow = sql`(now() AT TIME ZONE 'utc')`;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type NotebookSourceKind = "repo-doc" | "card" | "github-pr" | "link";

export const notebookSourceTable = pgTable(
  "notebook_source",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").$type<NotebookSourceKind>().notNull(),
    // A repo path, a task id, a PR number or a URL, unique per kind.
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    contentSha256: text("content_sha256").notNull(),
    chars: integer("chars").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    uniqueIndex("notebook_source_ref_idx").on(
      table.workspaceId,
      table.kind,
      table.ref,
    ),
  ],
);

export const notebookChunkTable = pgTable(
  "notebook_chunk",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => notebookSourceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    ordinal: integer("ordinal").notNull(),
    heading: text("heading").notNull().default(""),
    text: text("text").notNull(),
    // Float32 little-endian; null until the worker embeds the chunk.
    embedding: bytea("embedding"),
    embedModel: text("embed_model"),
    embeddedAt: timestamp("embedded_at", { mode: "date" }),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('russian', heading || ' ' || text)`),
  },
  (table) => [
    index("notebook_chunk_source_idx").on(table.sourceId, table.ordinal),
    index("notebook_chunk_pending_idx")
      .on(table.workspaceId)
      .where(sql`${table.embedding} IS NULL`),
    index("notebook_chunk_search_idx").using("gin", table.search),
  ],
);

// Chat over the sources (R-050). A thread belongs to the workspace, not to its
// author: everyone who reads the workspace reads its threads (R-041).
export const notebookThreadTable = pgTable(
  "notebook_thread",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    title: text("title").notNull(),
    createdBy: text("created_by").references(() => userTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("notebook_thread_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
  ],
);

export type NotebookMessageStatus =
  | "answered"
  | "retrieval-only"
  | "capped"
  | "rate-limited"
  | "failed"
  // A GOAL/CONSTRAINTS/ACCEPTANCE brief of the thread (TB-3), and a brief
  // call that reached the model without one: both carry the model, so both
  // count under the daily cap.
  | "brief"
  | "brief-failed";

// A citation keeps the source's name as it was, so the answer still reads
// after the chunk is re-cut or its source pruned.
export type NotebookCitation = {
  n: number;
  chunkId: string;
  kind: NotebookSourceKind;
  ref: string;
  title: string;
  heading: string;
};

export const notebookMessageTable = pgTable(
  "notebook_message",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => notebookThreadTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    status: text("status").$type<NotebookMessageStatus>(),
    citations: jsonb("citations")
      .$type<NotebookCitation[]>()
      .notNull()
      .default([]),
    // Set only when a cloud model answered: the daily cap counts these.
    model: text("model"),
    createdBy: text("created_by").references(() => userTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("notebook_message_thread_idx").on(table.threadId, table.createdAt),
    index("notebook_message_model_idx")
      .on(table.createdAt)
      .where(sql`${table.model} IS NOT NULL`),
  ],
);
