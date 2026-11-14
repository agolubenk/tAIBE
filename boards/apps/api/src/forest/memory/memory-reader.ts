import {
  type CachedClaudeMemReader,
  createClaudeMemReader,
  resolveProxyToken,
  resolveWorkerUrl,
  withCache,
} from "@kaneo/claude-mem-reader";
import { withRedaction } from "./redacting-reader";

let reader: CachedClaudeMemReader | undefined;

// One reader per process, so its last-known-good copy outlives a request and
// a card still shows its memory while the Mac with the worker sleeps (R-042).
// Read-only: the worker's GET endpoints, never claude-mem.db (R-040).
// The proxy token file (CLAUDE_MEM_PROXY_TOKEN_FILE, OPS-19) is read on every
// request; without it the reader goes without the header.
// The only reader of the API: observations leave it through `redact`
// (TB-137); a test keeps every other module from building its own.
export function getMemoryReader(): CachedClaudeMemReader {
  reader ??= withRedaction(
    withCache(
      createClaudeMemReader({
        baseUrl: resolveWorkerUrl(),
        proxyToken: () => resolveProxyToken(),
      }),
    ),
  );
  return reader;
}

// Optional: limit the scan to one claude-mem project (the repo's name).
export function memoryProject(): string | undefined {
  return process.env.CLAUDE_MEM_PROJECT?.trim() || undefined;
}
