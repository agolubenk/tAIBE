import { type OwnerQueueConfig, readQueueToken } from "./queue-config";

// work — plan rows of «Ход работ» (TB-106): the server only reads and patches
// them, it never creates one.
export type QueueCollection = "items" | "checks" | "work";

// One page of a collection. The console may answer the whole collection in
// one page (no next_offset) or cap it (truncated).
export type QueuePage = {
  docs: QueueDoc[];
  nextOffset: number | null;
  truncated: boolean;
  // A capped list: how many docs the token sees in the collection.
  total?: number;
  etag?: string;
  // 304 to ifNoneMatch: docs is empty, the cached page is still current.
  notModified?: boolean;
};

// TB-156: open — only items open to the owner, by the console's own rule
// (GET /db/items?open=1); ifNoneMatch — the ETag of a cached page.
export type QueueListOptions = { open?: boolean; ifNoneMatch?: string };

// An attachment of an inbox item, metadata only (ops-console GET /files).
export type QueueFile = {
  id: string;
  name: string;
  kind: string;
  size: number;
  createdAt: string;
};

// Attachments are a separate reader: the sync's QueueClient fakes stay as they are.
export interface QueueFileReader {
  files(itemId: string): Promise<QueueFile[]>;
}

export type QueueDoc = {
  id: string;
  data: Record<string, unknown>;
  version: number;
  updatedAt: number;
  product?: string;
};

// One row of the queue journal (oq_events), newest first: server time in ms,
// the writer's token name and the document after the write (F17).
export type QueueEvent = {
  at: number;
  actor: string;
  action: string;
  after: Record<string, unknown> | null;
};

// 409 from the queue: the version moved, or «create only» met an existing id.
export class QueueConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConflict";
  }
}

// 400 or 422 from the queue: it refused this document (schema, size). Only
// this item is wrong; the next ones may pass (TB-110).
export class QueueRejected extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "QueueRejected";
    this.status = status;
  }
}

// The queue as the sync sees it (F17, F18); tests use an in-memory fake with
// the same version rules.
export interface QueueClient {
  get(collection: QueueCollection, id: string): Promise<QueueDoc | null>;
  // ifVersion 0 creates only; otherwise the write needs this exact version.
  put(
    collection: QueueCollection,
    id: string,
    data: Record<string, unknown>,
    ifVersion: number,
  ): Promise<QueueDoc>;
  patch(
    collection: QueueCollection,
    id: string,
    data: Record<string, unknown>,
    ifVersion?: number,
  ): Promise<QueueDoc>;
  history(collection: QueueCollection, id: string): Promise<QueueEvent[]>;
  list(
    collection: QueueCollection,
    offset: number,
    options?: QueueListOptions,
  ): Promise<QueuePage>;
}

const TIMEOUT_MS = 15_000;
export const LIST_PAGE = 500;
const LIST_PAGES_MAX = 20;

export type ListResult = {
  docs: QueueDoc[];
  truncated: boolean;
  // One page: the console reads the whole visible collection in one query
  // (ops-console GET /db/:col ignores limit and offset), so the list is one
  // snapshot. A paged walk has no snapshot (the HTTP API has no as_of): a
  // write between pages can shift a doc out of the walk.
  snapshot: boolean;
};

// The whole collection page by page; a page that does not move the offset
// forward ends the walk, so a faulty next_offset cannot loop. Past the
// deadline (ms since epoch) no next page is read and the list is truncated.
export async function listAll(
  client: QueueClient,
  collection: QueueCollection,
  deadline = Number.POSITIVE_INFINITY,
): Promise<ListResult> {
  const docs: QueueDoc[] = [];
  let truncated = false;
  let offset = 0;
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    if (page > 0 && Date.now() > deadline) break;
    const next = await client.list(collection, offset);
    docs.push(...next.docs);
    truncated ||= next.truncated;
    if (next.nextOffset === null || next.nextOffset <= offset) {
      return { docs, truncated, snapshot: page === 0 };
    }
    offset = next.nextOffset;
  }
  return { docs, truncated: true, snapshot: false };
}

export function httpQueueClient(
  config: OwnerQueueConfig,
): QueueClient & QueueFileReader {
  const base = `${config.url}/api/oq/v1`;

  function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${readQueueToken(config)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function call(method: string, path: string, body?: unknown) {
    const response = await request(method, path, body);
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (response.status === 404 && method === "GET") return null;
    if (response.status === 409) {
      throw new QueueConflict(String(json.error ?? "version conflict"));
    }
    if (!response.ok) {
      const message =
        `owner queue ${method} ${path}: HTTP ${response.status} ${String(json.error ?? "")}`.trim();
      if (response.status === 400 || response.status === 422) {
        throw new QueueRejected(message, response.status);
      }
      throw new Error(message);
    }
    return json;
  }

  const docPath = (collection: QueueCollection, id: string) =>
    `/db/${collection}/${encodeURIComponent(id)}`;

  return {
    async get(collection, id) {
      return (await call("GET", docPath(collection, id))) as QueueDoc | null;
    },
    async put(collection, id, data, ifVersion) {
      return (await call("PUT", docPath(collection, id), {
        data,
        ifVersion,
      })) as QueueDoc;
    },
    async patch(collection, id, data, ifVersion) {
      return (await call("PATCH", docPath(collection, id), {
        data,
        ...(ifVersion === undefined ? {} : { ifVersion }),
      })) as QueueDoc;
    },
    async history(collection, id) {
      const json = await call(
        "GET",
        `/history/${collection}/${encodeURIComponent(id)}`,
      );
      return ((json?.events as QueueEvent[] | undefined) ?? []).slice(0, 50);
    },
    async list(collection, offset, options = {}) {
      const query = new URLSearchParams({
        limit: String(LIST_PAGE),
        offset: String(offset),
      });
      if (options.open) query.set("open", "1");
      const path = `/db/${collection}?${query}`;
      const response = await request(
        "GET",
        path,
        undefined,
        options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : {},
      );
      const etag = response.headers.get("etag") ?? undefined;
      if (response.status === 304) {
        return {
          docs: [],
          nextOffset: null,
          truncated: false,
          etag,
          notModified: true,
        };
      }
      const json = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        throw new Error(
          `owner queue GET ${path}: HTTP ${response.status} ${String(json.error ?? "")}`.trim(),
        );
      }
      // An old console does not know ?open=1 and answers the whole list.
      if (options.open && json.open !== true) {
        throw new Error(`owner queue GET ${path}: open filter not applied`);
      }
      const next = json.next_offset;
      return {
        docs: (json.docs as QueueDoc[] | undefined) ?? [],
        nextOffset: typeof next === "number" ? next : null,
        truncated: json.truncated === true,
        total: typeof json.total === "number" ? json.total : undefined,
        etag,
      };
    },
    async files(itemId) {
      const json = await call(
        "GET",
        `/files?item=${encodeURIComponent(itemId)}`,
      );
      const files = (json?.files as QueueFile[] | undefined) ?? [];
      return files.map(({ id, name, kind, size, createdAt }) => ({
        id,
        name,
        kind,
        size,
        createdAt,
      }));
    },
  };
}
