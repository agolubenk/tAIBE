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
};

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
  list(collection: QueueCollection, offset: number): Promise<QueuePage>;
}

const TIMEOUT_MS = 15_000;
export const LIST_PAGE = 500;
const LIST_PAGES_MAX = 20;

// The whole collection page by page; a page that does not move the offset
// forward ends the walk, so a faulty next_offset cannot loop.
export async function listAll(
  client: QueueClient,
  collection: QueueCollection,
): Promise<{ docs: QueueDoc[]; truncated: boolean }> {
  const docs: QueueDoc[] = [];
  let truncated = false;
  let offset = 0;
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    const next = await client.list(collection, offset);
    docs.push(...next.docs);
    truncated ||= next.truncated;
    if (next.nextOffset === null || next.nextOffset <= offset) {
      return { docs, truncated };
    }
    offset = next.nextOffset;
  }
  return { docs, truncated: true };
}

export function httpQueueClient(config: OwnerQueueConfig): QueueClient {
  const base = `${config.url}/api/oq/v1`;

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${readQueueToken(config)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (response.status === 404 && method === "GET") return null;
    if (response.status === 409) {
      throw new QueueConflict(String(json.error ?? "version conflict"));
    }
    if (!response.ok) {
      throw new Error(
        `owner queue ${method} ${path}: HTTP ${response.status} ${String(json.error ?? "")}`.trim(),
      );
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
    async list(collection, offset) {
      const json = await call(
        "GET",
        `/db/${collection}?limit=${LIST_PAGE}&offset=${offset}`,
      );
      const next = json?.next_offset;
      return {
        docs: (json?.docs as QueueDoc[] | undefined) ?? [],
        nextOffset: typeof next === "number" ? next : null,
        truncated: json?.truncated === true,
      };
    },
  };
}
