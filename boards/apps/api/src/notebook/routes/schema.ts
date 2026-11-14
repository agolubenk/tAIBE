import {
  nullableResponseTimestamp,
  pagingNumber,
  responseTimestamp,
  z,
} from "../../openapi";
import { EMBED_RESULTS_MAX } from "../embed/embed-work";

export const SOURCE_TEXT_MAX = 500_000;
// SOURCE_TEXT_MAX of ordinary prose is ~320 chunks; a page or PR of tiny
// sections must not cut into tens of thousands.
export const FETCHED_SOURCE_CHUNKS_MAX = 2000;
export const SEARCH_LIMIT_MAX = 20;
// Russian text is two bytes a character before JSON escaping.
export const SOURCE_BODY_BYTES = 2 * 1024 * 1024;
// 64 base64 vectors of 4096 floats are ~1.4 MB.
export const EMBED_RESULTS_BODY_BYTES = 2 * 1024 * 1024;

export const workspaceParam = z.object({ workspaceId: z.string() });

const sourceKind = z.enum(["repo-doc", "card", "github-pr", "link"]);
// Cards come from the board itself (POST /sources/cards), never uploaded.
const uploadKind = z.enum(["repo-doc", "github-pr", "link"]);

export const putSourceBody = z.object({
  kind: uploadKind,
  ref: z.string().min(1).max(512).openapi({
    description: "A repo path, PR number or URL; unique per kind.",
  }),
  title: z.string().min(1).max(300),
  text: z.string().max(SOURCE_TEXT_MAX),
});

export const upsertedSourceSchema = z
  .object({
    sourceId: z.string(),
    changed: z.boolean().openapi({
      description: "False when the text matched the stored sha256.",
    }),
    chunks: z.number().int(),
  })
  .openapi("NotebookUpsertedSource");

// Percent-encoding can make a pasted URL longer than an uploaded ref.
export const SOURCE_URL_MAX = 2048;
export const SOURCE_URL_BODY_BYTES = 8 * 1024;

export const addLinkBody = z.object({
  url: z.string().trim().min(1).max(SOURCE_URL_MAX).openapi({
    description:
      "An https page with HTML, Markdown or plain text, up to 2 MB. The same URL again refreshes it.",
  }),
});

export const addPullRequestBody = z.object({
  url: z.string().trim().min(1).max(SOURCE_URL_MAX).openapi({
    description:
      "A GitHub pull request URL, or its notebook ref owner/repo#12. The same PR again refreshes it.",
  }),
});

export const addedSourceSchema = z
  .object({
    sourceId: z.string(),
    kind: z.enum(["github-pr", "link"]),
    ref: z.string(),
    title: z.string(),
    changed: z.boolean().openapi({
      description: "False when the fetched text matched the stored one.",
    }),
    chunks: z.number().int(),
  })
  .openapi("NotebookAddedSource");

export const sourcesSchema = z
  .object({
    model: z.string(),
    sources: z.array(
      z.object({
        kind: sourceKind,
        ref: z.string(),
        title: z.string(),
        contentSha256: z.string(),
        chars: z.number().int(),
        updatedAt: responseTimestamp,
        chunks: z.number().int(),
        embedded: z.number().int().openapi({
          description: "Chunks embedded with the current model.",
        }),
      }),
    ),
  })
  .openapi("NotebookSources");

export const pruneSourcesBody = z.object({
  kind: uploadKind,
  keep: z.array(z.string().min(1).max(512)).max(20_000).openapi({
    description: "Every ref of this kind that still exists; the rest goes.",
  }),
});

export const prunedSchema = z
  .object({ deleted: z.number().int() })
  .openapi("NotebookPruned");

export const cardSyncSchema = z
  .object({
    cards: z.number().int().openapi({
      description: "Cards the notebook holds after the sync.",
    }),
    changed: z.number().int().openapi({
      description: "Cards whose text changed and were cut again.",
    }),
    pruned: z.number().int().openapi({
      description:
        "Card sources removed: the card is gone, archived, or in a project not every member may open.",
    }),
  })
  .openapi("NotebookCardSync");

export const embedWorkQuery = z.object({
  wait: pagingNumber(0, 25, 0).openapi({
    description: "Seconds to hold the request open when there is no work.",
  }),
});

const embedKind = z.enum(["query", "chunk"]);

export const embedWorkSchema = z
  .object({
    model: z.string(),
    items: z.array(
      z.object({ kind: embedKind, id: z.string(), text: z.string() }),
    ),
  })
  .openapi("NotebookEmbedWork");

export const embedResultsBody = z.object({
  model: z.string().min(1).max(200),
  items: z
    .array(
      z.object({
        kind: embedKind,
        id: z.string().min(1).max(64),
        embedding: z.string().min(1).max(24_000).openapi({
          description: "Base64 of float32 little-endian values.",
        }),
      }),
    )
    .max(EMBED_RESULTS_MAX),
});

export const embedSavedSchema = z
  .object({ saved: z.number().int(), rejected: z.number().int() })
  .openapi("NotebookEmbedSaved");

// A 500-character query is at most ~3 KB even with every character escaped.
export const SEARCH_BODY_BYTES = 8 * 1024;

export const searchBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
  mode: z.enum(["hybrid", "keyword"]).optional().openapi({
    description:
      "hybrid adds meaning-based ranking when the embedding worker is online.",
  }),
});

export const searchResultsSchema = z
  .object({
    mode: z.enum(["hybrid", "keyword"]).openapi({
      description: "The ranking actually used for this answer.",
    }),
    results: z.array(
      z.object({
        chunkId: z.string(),
        source: z.object({
          kind: sourceKind,
          ref: z.string(),
          title: z.string(),
        }),
        heading: z.string(),
        text: z.string(),
        score: z.number(),
        matchedBy: z.array(z.enum(["vector", "keyword"])),
      }),
    ),
  })
  .openapi("NotebookSearchResults");

export const notebookStatusSchema = z
  .object({
    model: z.string(),
    workerOnline: z.boolean(),
    workerSeenAt: nullableResponseTimestamp,
    sources: z.number().int(),
    chunks: z.number().int(),
    embedded: z.number().int(),
    indexed: z.number().int().openapi({
      description:
        "Embedded chunks that meaning-based search holds, newest first up to its memory budget. Below embedded, the older chunks are found by words only.",
    }),
    llm: z.object({
      configured: z.boolean().openapi({
        description: "False: answers carry sources without written text.",
      }),
      model: z.string().nullable(),
      callsToday: z.number().int(),
      dailyMax: z.number().int().nullable(),
    }),
  })
  .openapi("NotebookStatus");

export const QUESTION_MAX = 2000;
export const CHAT_BODY_BYTES = 16 * 1024;

export const threadParam = z.object({
  workspaceId: z.string(),
  threadId: z.string(),
});

export const askBody = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX),
});

const threadSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: responseTimestamp,
  updatedAt: responseTimestamp,
});

const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  status: z
    .enum([
      "answered",
      "retrieval-only",
      "capped",
      "rate-limited",
      "failed",
      "brief",
      "brief-failed",
    ])
    .nullable()
    .openapi({
      description:
        "Assistant turns only. answered is a written answer; retrieval-only, capped, rate-limited and failed carry the sources without one. brief is a GOAL/CONSTRAINTS/ACCEPTANCE brief of the thread, brief-failed a brief call that returned none.",
    }),
  citations: z.array(
    z.object({
      n: z.number().int(),
      chunkId: z.string(),
      kind: sourceKind,
      ref: z.string(),
      title: z.string(),
      heading: z.string(),
    }),
  ),
  model: z.string().nullable(),
  createdAt: responseTimestamp,
});

export const threadsSchema = z
  .object({ threads: z.array(threadSchema) })
  .openapi("NotebookThreads");

export const threadWithMessagesSchema = z
  .object({ thread: threadSchema, messages: z.array(messageSchema) })
  .openapi("NotebookThread");
