import {
  type CachedClaudeMemReader,
  createCardMemoryClient,
  createClaudeMemReader,
  resolveProxyToken,
  resolveWorkerUrl,
  withCache,
} from "@kaneo/claude-mem-reader";
import {
  type CardMemoryFinder,
  createCardMemoryFinder,
} from "./find-card-memory";

let reader: CachedClaudeMemReader | undefined;
let cardMemory: CardMemoryFinder | undefined;

// One reader per process, so its last-known-good copy outlives a request and
// a card still shows its memory while the Mac with the worker sleeps (R-042).
// Read-only: the worker's GET endpoints. The proxy token file
// (CLAUDE_MEM_PROXY_TOKEN_FILE, OPS-19) is read on every request; without it
// the reader goes without the header.
export function getMemoryReader(): CachedClaudeMemReader {
  reader ??= withCache(
    createClaudeMemReader({
      baseUrl: resolveWorkerUrl(),
      proxyToken: () => resolveProxyToken(),
    }),
  );
  return reader;
}

// Card memory (TB-113): the Mac proxy's exact key search in claude-mem.db,
// read-only — the one R-040 exception, owner decision d-tb113-r040-1311.
// One finder per process, so its stale copy outlives a request.
// The proxy answers in milliseconds (card-memory-db.mjs); 1.5 s instead of
// the reader's 5 s keeps a card opening short when the Mac sleeps.
const CARD_MEMORY_TIMEOUT_MS = 1_500;

export function getCardMemoryFinder(): CardMemoryFinder {
  cardMemory ??= createCardMemoryFinder(
    createCardMemoryClient({
      baseUrl: resolveWorkerUrl(),
      proxyToken: () => resolveProxyToken(),
      timeoutMs: CARD_MEMORY_TIMEOUT_MS,
    }),
  );
  return cardMemory;
}
