import { type OwnerQueueConfig, readQueueToken } from "./queue-config";

export type QueueCollection = "items" | "checks";

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
}

const TIMEOUT_MS = 15_000;

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
  };
}
