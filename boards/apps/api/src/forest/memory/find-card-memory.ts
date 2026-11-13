import type {
  CardMemoryClient,
  CardMemoryKeyResult,
} from "@kaneo/claude-mem-reader";

// A fresh answer is reused for a minute; when the Mac proxy fails, the last
// answer is shown as stale for up to a day, then «unavailable» (TB-113).
// After a failure the proxy is not asked again for 10 s: a sleeping Mac must
// not hold every card opening for the client's timeout. Calls for one key set
// that come while it is being asked share that one request (TB-121): a burst
// of MCP calls for a card is one request to the proxy, not one each.
export const FRESH_MS = 60_000;
export const STALE_MS = 24 * 60 * 60_000;
export const FAILED_MS = 10_000;
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

// No key of the card fits a searchable form: there is nothing to ask, which
// is not a proxy failure.
const NOTHING_TO_SEARCH: CardMemory = {
  available: true,
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
  const asking = new Map<string, Promise<CardMemory>>();
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
        stale: true,
        fetchedAt: new Date(known.fetchedAt),
        keys: known.keys,
      };
    }
    if (known) cache.delete(id);
    return UNAVAILABLE;
  }

  async function ask(
    id: string,
    keys: string[],
    known: Entry | undefined,
    now: number,
  ): Promise<CardMemory> {
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
      failedUntil = now + FAILED_MS;
      return lastAnswer(id, known, now);
    }
  }

  return async (keys) => {
    if (keys.length === 0) return NOTHING_TO_SEARCH;
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
    if (now < failedUntil) return lastAnswer(id, known, now);
    const pending = asking.get(id);
    if (pending) return pending;
    const request = ask(id, keys, known, now).finally(() => {
      asking.delete(id);
    });
    asking.set(id, request);
    return request;
  };
}
