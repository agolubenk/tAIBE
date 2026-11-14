import {
  type CardBinding,
  type CachedClaudeMemReader,
  matchObservationToCards,
  type Observation,
} from "@kaneo/claude-mem-reader";

export const MEMORY_PAGE_SIZE = 100;
export const MEMORY_PAGES = 2;

export type CardMemoryItem = {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  createdAt: string;
  matchedOn: "branch" | "task-id";
  matchedValue: string;
  source: "metadata" | "text";
};

export type CardMemory = {
  available: boolean;
  stale: boolean;
  fetchedAt: Date | null;
  scanned: number;
  items: CardMemoryItem[];
};

const UNAVAILABLE: CardMemory = {
  available: false,
  stale: false,
  fetchedAt: null,
  scanned: 0,
  items: [],
};

// The card's observations among the worker's latest ones. Scans a bounded
// window instead of searching: the worker has no filter by card, and a card
// is read while it is worked on, so its observations are recent. A worker
// that is down and was never read answers «unavailable», not an error.
export async function findCardMemory(
  reader: CachedClaudeMemReader,
  binding: CardBinding,
  options: { project?: string } = {},
): Promise<CardMemory> {
  const observations: Observation[] = [];
  let stale = false;
  let fetchedAt: number | null = null;

  for (let page = 0; page < MEMORY_PAGES; page++) {
    const result = await reader
      .listObservations({
        project: options.project,
        limit: MEMORY_PAGE_SIZE,
        offset: page * MEMORY_PAGE_SIZE,
      })
      .catch(() => null);
    if (!result) {
      if (page === 0) return UNAVAILABLE;
      break;
    }
    stale ||= result.stale;
    fetchedAt = Math.min(fetchedAt ?? result.fetchedAt, result.fetchedAt);
    observations.push(...result.data.items);
    if (!result.data.hasMore) break;
  }

  const items: CardMemoryItem[] = [];
  for (const observation of observations) {
    const [best] = matchObservationToCards(observation, [binding]);
    if (!best) continue;
    items.push({
      id: observation.id,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      createdAt: observation.createdAt,
      matchedOn: best.matchedOn,
      matchedValue: best.matchedValue,
      source: best.source,
    });
  }

  return {
    available: true,
    stale,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt),
    scanned: observations.length,
    items,
  };
}
