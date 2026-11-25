import type {
  CardMemoryClient,
  CardMemoryKeyResult,
} from "@kaneo/claude-mem-reader";

// A fresh answer is reused for a minute; when the Mac proxy fails, the last
// answer is shown as stale for up to a day, then «unavailable» (TB-113).
// After a failure the proxy is not asked again for 10 s: a sleeping Mac must
// not hold every card opening for the client's timeout.
export const FRESH_MS = 60_000;
export const STALE_MS = 24 * 60 * 60_000;
export const FAILED_MS = 10_000;
const CACHE_ENTRIES = 500;

// Why available is false: the proxy failed and nothing is cached, or the
// workspace has no claude-mem projects in CLAUDE_MEM_PROJECTS (R-002, TB-58).
export type CardMemoryReason = "worker-unreachable" | "no-product-map";

export type CardMemory = {
  available: boolean;
  reason: CardMemoryReason | null;
  stale: boolean;
  fetchedAt: Date | null;
  keys: CardMemoryKeyResult[];
};

const UNAVAILABLE: CardMemory = {
  available: false,
  reason: "worker-unreachable",
  stale: false,
  fetchedAt: null,
  keys: [],
};

// Fail closed: a workspace without its claude-mem projects asks nothing.
const NO_PRODUCT_MAP: CardMemory = { ...UNAVAILABLE, reason: "no-product-map" };

// No key of the card fits a searchable form: there is nothing to ask, which
// is not a proxy failure.
const NOTHING_TO_SEARCH: CardMemory = {
  available: true,
  reason: null,
  stale: false,
  fetchedAt: null,
  keys: [],
};

type Entry = { keys: CardMemoryKeyResult[]; fetchedAt: number };

// roots: the workspace's claude-mem project roots (memoryRoots); the proxy
// counts and shows only their observations and their worktrees' (TB-58).
export type CardMemoryFinder = (
  keys: string[],
  roots: readonly string[],
) => Promise<CardMemory>;

// The cache key is the root set and the key set: two workspaces asking the
// same key do not share an answer. The keys and titles live in this process's
// memory only and never reach a log: a failure is not logged with them.
export function createCardMemoryFinder(
  client: CardMemoryClient,
  clock: () => number = Date.now,
): CardMemoryFinder {
  const cache = new Map<string, Entry>();
  // The proxy fails as a whole (Mac asleep, no database, busy, rate limit),
  // so one failure pauses the calls for every key set.
  let failedUntil = 0;

  function remember(id: string, entry: Entry) {
    cache.delete(id);
    cache.set(id, entry);
    if (cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function lastAnswer(
    id: string,
    known: Entry | undefined,
    now: number,
  ): CardMemory {
    if (known && now - known.fetchedAt < STALE_MS) {
      return {
        available: true,
        reason: null,
        stale: true,
        fetchedAt: new Date(known.fetchedAt),
        keys: known.keys,
      };
    }
    if (known) cache.delete(id);
    return UNAVAILABLE;
  }

  return async (keys, roots) => {
    if (roots.length === 0) return NO_PRODUCT_MAP;
    if (keys.length === 0) return NOTHING_TO_SEARCH;
    // A root has no space or line break, a key no space (memory-keys.ts).
    const id = `${[...roots].sort().join(" ")}\n${[...keys].sort().join(" ")}`;
    const now = clock();
    const known = cache.get(id);
    if (known && now - known.fetchedAt < FRESH_MS) {
      return {
        available: true,
        reason: null,
        stale: false,
        fetchedAt: new Date(known.fetchedAt),
        keys: known.keys,
      };
    }
    if (now < failedUntil) return lastAnswer(id, known, now);
    try {
      const answer = await client.find(keys, roots);
      remember(id, { keys: answer.keys, fetchedAt: now });
      return {
        available: true,
        reason: null,
        stale: false,
        fetchedAt: new Date(now),
        keys: answer.keys,
      };
    } catch {
      failedUntil = now + FAILED_MS;
      return lastAnswer(id, known, now);
    }
  };
}
