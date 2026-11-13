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

// Why available is false: the worker was never read, or the workspace has no
// claude-mem projects in CLAUDE_MEM_PROJECTS (TB-58).
export type CardMemoryReason = "worker-unreachable" | "no-product-map";

export type CardMemory = {
  available: boolean;
  reason: CardMemoryReason | null;
  stale: boolean;
  fetchedAt: Date | null;
  scanned: number;
  items: CardMemoryItem[];
};

const UNAVAILABLE: CardMemory = {
  available: false,
  reason: "worker-unreachable",
  stale: false,
  fetchedAt: null,
  scanned: 0,
  items: [],
};

const NO_PRODUCT_MAP: CardMemory = { ...UNAVAILABLE, reason: "no-product-map" };

// A claude-mem project is the product's when it is one of its roots or a
// worktree of one («tAIBE/<topic>»). «tAIBE-old» is not «tAIBE».
export function inRoots(project: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => project === root || project.startsWith(`${root}/`),
  );
}

// The card's observations among the worker's latest ones. Scans a bounded
// window instead of searching: the worker has no filter by card, and a card
// is read while it is worked on, so its observations are recent. A worker
// that is down and was never read answers «unavailable», not an error.
// Only the observations of the product's roots are kept and counted: the
// worker filters by exact project name, and worktrees are projects of their
// own, so the filter is applied here (R-002, TB-58).
export async function findCardMemory(
  reader: CachedClaudeMemReader,
  binding: CardBinding,
  roots: readonly string[],
): Promise<CardMemory> {
  if (roots.length === 0) return NO_PRODUCT_MAP;
  const observations: Observation[] = [];
  let stale = false;
  let fetchedAt: number | null = null;

  for (let page = 0; page < MEMORY_PAGES; page++) {
    const result = await reader
      .listObservations({
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
    observations.push(
      ...result.data.items.filter((item) => inRoots(item.project, roots)),
    );
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
    reason: null,
    stale,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt),
    scanned: observations.length,
    items,
  };
}
