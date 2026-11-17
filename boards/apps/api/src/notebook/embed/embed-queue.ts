import { randomUUID } from "node:crypto";

// In-process meeting point between the API and the Mac embedding worker. The
// worker reaches the API through the tunnel, never the other way round, so a
// query that needs a vector waits here until the worker's long poll takes it.
// State is per process: the notebook runs on a single API instance.

export const WORKER_ONLINE_MS = 40_000;
const PENDING_QUERIES_MAX = 32;
const CHUNK_LEASE_MS = 60_000;

type PendingQuery = {
  id: string;
  text: string;
  taken: boolean;
  resolve: (vector: Buffer | null) => void;
};

const queries = new Map<string, PendingQuery[]>();
const queryOwner = new Map<string, string>();
const wakers = new Map<string, Set<() => void>>();
const workerSeenAt = new Map<string, number>();
const chunkLeases = new Map<string, Map<string, number>>();
// TB-212: a poll claims work before it parks, and the claim waits for the
// database. Work that arrives during that wait finds no parked poll, so the
// poll slept its whole wait and a search query timed out. Each notice moves
// the workspace's generation; a poll that read an older one does not park.
const generations = new Map<string, number>();

export function embedWorkGeneration(workspaceId: string) {
  return generations.get(workspaceId) ?? 0;
}

export function notifyEmbedWork(workspaceId: string) {
  generations.set(workspaceId, embedWorkGeneration(workspaceId) + 1);
  const waiting = wakers.get(workspaceId);
  if (!waiting) return;
  wakers.delete(workspaceId);
  for (const wake of waiting) wake();
}

export function markWorkerSeen(workspaceId: string, now = Date.now()) {
  workerSeenAt.set(workspaceId, now);
}

export function workerLastSeen(workspaceId: string): number | null {
  return workerSeenAt.get(workspaceId) ?? null;
}

// A worker parked in a long poll is online however long it has waited.
export function isWorkerOnline(workspaceId: string, now = Date.now()) {
  if (wakers.get(workspaceId)?.size) return true;
  const seen = workerSeenAt.get(workspaceId);
  return seen !== undefined && now - seen < WORKER_ONLINE_MS;
}

// Null when the worker does not answer in time or the queue is full: the
// caller falls back to keyword search instead of waiting longer.
export function requestQueryEmbedding(
  workspaceId: string,
  text: string,
  timeoutMs: number,
): Promise<Buffer | null> {
  const list = queries.get(workspaceId) ?? [];
  if (list.length >= PENDING_QUERIES_MAX) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    const finish = (vector: Buffer | null) => {
      clearTimeout(timer);
      queryOwner.delete(id);
      const current = queries.get(workspaceId);
      const left = current?.filter((query) => query.id !== id) ?? [];
      if (left.length) queries.set(workspaceId, left);
      else queries.delete(workspaceId);
      resolve(vector);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    list.push({ id, text, taken: false, resolve: finish });
    queries.set(workspaceId, list);
    queryOwner.set(id, workspaceId);
    notifyEmbedWork(workspaceId);
  });
}

export function takeQueries(workspaceId: string, max: number) {
  const taken: { id: string; text: string }[] = [];
  for (const query of queries.get(workspaceId) ?? []) {
    if (taken.length >= max) break;
    if (query.taken) continue;
    query.taken = true;
    taken.push({ id: query.id, text: query.text });
  }
  return taken;
}

// False for an unknown id: the query timed out or came from another workspace.
export function resolveQuery(
  workspaceId: string,
  id: string,
  vector: Buffer,
): boolean {
  if (queryOwner.get(id) !== workspaceId) return false;
  const query = queries.get(workspaceId)?.find((item) => item.id === id);
  if (!query) return false;
  query.resolve(vector);
  return true;
}

// A chunk handed to the worker is skipped by the next polls until its
// vector comes back or the lease runs out, so a crashed batch is retried.
export function leasedChunkIds(workspaceId: string, now = Date.now()) {
  const leases = chunkLeases.get(workspaceId);
  if (!leases) return [];
  for (const [id, until] of leases) if (until <= now) leases.delete(id);
  return [...leases.keys()];
}

export function leaseChunks(
  workspaceId: string,
  ids: string[],
  now = Date.now(),
) {
  if (!ids.length) return;
  const leases = chunkLeases.get(workspaceId) ?? new Map<string, number>();
  for (const id of ids) leases.set(id, now + CHUNK_LEASE_MS);
  chunkLeases.set(workspaceId, leases);
}

export function releaseChunks(workspaceId: string, ids: string[]) {
  const leases = chunkLeases.get(workspaceId);
  if (!leases) return;
  for (const id of ids) leases.delete(id);
}

// Resolves on new work, on timeout or when the worker hangs up. `since` is
// the generation the caller read before it claimed work: a notice after that
// read resolves at once instead of being lost (TB-212).
export function waitForEmbedWork(
  workspaceId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  since = embedWorkGeneration(workspaceId),
): Promise<void> {
  return new Promise((resolve) => {
    if (embedWorkGeneration(workspaceId) !== since || signal?.aborted) {
      resolve();
      return;
    }
    const waiting = wakers.get(workspaceId) ?? new Set<() => void>();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      wakers.get(workspaceId)?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    waiting.add(done);
    wakers.set(workspaceId, waiting);
  });
}

export function resetEmbedQueueForTests() {
  for (const list of queries.values()) {
    for (const query of [...list]) query.resolve(null);
  }
  queries.clear();
  queryOwner.clear();
  for (const waiting of wakers.values()) for (const wake of waiting) wake();
  wakers.clear();
  workerSeenAt.clear();
  chunkLeases.clear();
  generations.clear();
}
