import {
  type CachedClaudeMemReader,
  createCardMemoryClient,
  createClaudeMemReader,
  isMemoryProjectRoot,
  MAX_MEMORY_PROJECTS,
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

// The product boundary (R-002, TB-58): a product is a workspace, and its cards
// read only its own claude-mem projects — the repo folder («tAIBE») and its
// worktrees («tAIBE/<topic>»). CLAUDE_MEM_PROJECTS is the pair list of
// OQ_WORKSPACE_PRODUCTS: «<workspaceId>=<root>[|<root>], …». A workspace that
// is not on the list gets no roots and reads nothing (fail closed). A root
// outside the proxy's form is dropped, and at most 4 are kept: a wrong entry
// shows less memory, never another product's.
export function memoryRoots(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  for (const pair of (env.CLAUDE_MEM_PROJECTS ?? "").split(",")) {
    const [id, roots] = pair.split("=").map((part) => part.trim());
    if (!id || id !== workspaceId || !roots) continue;
    const valid = roots
      .split("|")
      .map((root) => root.trim())
      .filter(isMemoryProjectRoot);
    return [...new Set(valid)].slice(0, MAX_MEMORY_PROJECTS);
  }
  return [];
}

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
