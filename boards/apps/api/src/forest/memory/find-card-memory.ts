import type {
  CardMemoryClient,
  CardMemoryKeyResult,
} from "@kaneo/claude-mem-reader";

// A fresh answer is reused for a minute; when the Mac proxy fails, the last
// answer is shown as stale for up to a day, then «unavailable» (TB-113).
export const FRESH_MS = 60_000;
export const STALE_MS = 24 * 60 * 60_000;
const CACHE_ENTRIES = 500;

export type CardMemory = {
  available: boolean;
  stale: boolean;
  fetchedAt: Date | null;
  keys: CardMemoryKeyResult[];
};

const UNAVAILABLE: CardMemory = {
  available: false,
  stale: false,
  fetchedAt: null,
  keys: [],
};

type Entry = { keys: CardMemoryKeyResult[]; fetchedAt: number };

export type CardMemoryFinder = (keys: string[]) => Promise<CardMemory>;

// The cache key is the key set. The keys and titles live in this process's
// memory only and never reach a log: a failure is not logged with them.
export function createCardMemoryFinder(
  client: CardMemoryClient,
  clock: () => number = Date.now,
): CardMemoryFinder {
  const cache = new Map<string, Entry>();

  function remember(id: string, entry: Entry) {
    cache.delete(id);
    cache.set(id, entry);
    if (cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  return async (keys) => {
    if (keys.length === 0) return UNAVAILABLE;
    const id = [...keys].sort().join(" ");
    const now = clock();
    const known = cache.get(id);
    if (known && now - known.fetchedAt < FRESH_MS) {
      return {
        available: true,
        stale: false,
        fetchedAt: new Date(known.fetchedAt),
        keys: known.keys,
      };
    }
    try {
      const answer = await client.find(keys);
      remember(id, { keys: answer.keys, fetchedAt: now });
      return {
        available: true,
        stale: false,
        fetchedAt: new Date(now),
        keys: answer.keys,
      };
    } catch {
      if (known && now - known.fetchedAt < STALE_MS) {
        return {
          available: true,
          stale: true,
          fetchedAt: new Date(known.fetchedAt),
          keys: known.keys,
        };
      }
      if (known) cache.delete(id);
      return UNAVAILABLE;
    }
  };
}
