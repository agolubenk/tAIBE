import {
  hasRedactionMarker,
  type RestoreResult,
  redactDeep,
  restoreRedacted,
} from "@kaneo/redact/restore";
import type { Context } from "hono";
import { ApiError } from "../errors/api-error";

// TB-143: free text reaches a model through a caller with a token (API key,
// agent key, MCP bearer session). The web app uses a cookie session, sends
// no token and keeps seeing the real text: it edits that same text. The
// test is the one resolveForestActor uses to tell an agent from a person.
export function isTokenCaller(c: Context): boolean {
  return (
    Boolean(c.get("apiKey")) ||
    Boolean(c.req.header("authorization")) ||
    Boolean(c.req.header("x-api-key"))
  );
}

/** For a caller with a token, every string of the response goes through redact. */
export function maskForTokenCaller<T>(c: Context, value: T): T {
  return isTokenCaller(c) ? redactDeep(value) : value;
}

const KEEP_BLOCKS =
  "Send each block (paragraph) with a [REDACTED:…] marker back exactly as you read it and edit the other blocks; a person removes a secret in the web app.";

function mismatchMessage(result: Exclude<RestoreResult, { ok: true }>): string {
  if (result.reason === "count") {
    return `The text has ${result.received} [REDACTED:${result.kind}] markers; the stored text has ${result.expected} values of that kind. ${KEEP_BLOCKS}`;
  }
  if (result.reason === "context") {
    return `The text above a block with a [REDACTED:…] marker changed and holds raw HTML, a code fence or $$. Keep that text as you read it or remove them. ${KEEP_BLOCKS}`;
  }
  return `A block with a [REDACTED:…] marker differs from the stored text, or a marker moved. ${KEEP_BLOCKS}`;
}

/**
 * A caller with a token writes back text it read masked: the markers get
 * the stored values back. The write is refused (409) if a kind has a
 * different number of markers than stored values, if a block with a marker
 * changed (a moved marker could put the secret into a URL), or if changed
 * text above such a block holds raw HTML, a code fence or `$$`.
 */
export async function restoreForTokenCaller(
  c: Context,
  incoming: string,
  loadStored: () => Promise<string | null | undefined>,
): Promise<string> {
  if (!isTokenCaller(c) || !hasRedactionMarker(incoming)) return incoming;
  const result = restoreRedacted((await loadStored()) ?? "", incoming);
  if (result.ok) return result.text;
  throw new ApiError(409, {
    code: "REDACTED_MARKERS_MISMATCH",
    message: mismatchMessage(result),
  });
}
