import {
  type CachedClaudeMemReader,
  createClaudeMemReader,
  resolveProxyToken,
  resolveWorkerUrl,
  withCache,
} from "@kaneo/claude-mem-reader";

let reader: CachedClaudeMemReader | undefined;

// One reader per process, so its last-known-good copy outlives a request and
// a card still shows its memory while the Mac with the worker sleeps (R-042).
// Read-only: the worker's GET endpoints, never claude-mem.db (R-040).
// The proxy token file (CLAUDE_MEM_PROXY_TOKEN_FILE, OPS-19) is read on every
// request; without it the reader goes without the header.
export function getMemoryReader(): CachedClaudeMemReader {
  reader ??= withCache(
    createClaudeMemReader({
      baseUrl: resolveWorkerUrl(),
      proxyToken: () => resolveProxyToken(),
    }),
  );
  return reader;
}

// The product boundary (R-002, TB-58): a product is a workspace, and its cards
// read only its own claude-mem projects — the repo folder («tAIBE») and its
// worktrees («tAIBE/<topic>»). CLAUDE_MEM_PROJECTS is the pair list of
// OQ_WORKSPACE_PRODUCTS: «<workspaceId>=<root>[|<root>], …». A workspace that
// is not on the list gets no roots and reads nothing (fail closed).
export function memoryRoots(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  for (const pair of (env.CLAUDE_MEM_PROJECTS ?? "").split(",")) {
    const [id, roots] = pair.split("=").map((part) => part.trim());
    if (!id || id !== workspaceId || !roots) continue;
    return roots
      .split("|")
      .map((root) => root.trim())
      .filter(Boolean);
  }
  return [];
}
