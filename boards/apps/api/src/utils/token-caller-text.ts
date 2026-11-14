import {
  hasRedactionMarker,
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

/**
 * A caller with a token writes back text it read masked: the markers get
 * the stored values back. If a kind has a different number of markers than
 * stored values, the write is refused (409): the order is ambiguous, and a
 * wrong value in the wrong place is worse than a refusal.
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
    message: `The text has ${result.received} [REDACTED:${result.kind}] markers; the stored text has ${result.expected} values of that kind. Keep the [REDACTED:…] markers in place; a person removes a secret in the web app.`,
  });
}
