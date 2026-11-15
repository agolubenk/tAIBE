import { hasRedactionMarker } from "@kaneo/redact/restore";
import type { Context } from "hono";
import { ApiError } from "../../errors/api-error";
import {
  isTokenCaller,
  restoreForTokenCaller,
} from "../../utils/token-caller-text";
import { redactContextMeta } from "../context/redact-context";
import { type CardMeta, loadCardMeta } from "./card-meta";
import type { CardMetaPatch } from "./card-patch";

// TB-141: a caller with a token reads the meta's free text masked, the same
// mask as the meta of the context pack, so both reads give the same text.
// That includes the answer of its own write, which holds the restored values.
// The web app's session reads the stored text: it edits that text.
export function maskMetaText(c: Context, meta: CardMeta): CardMeta {
  return isTokenCaller(c) ? redactContextMeta(meta) : meta;
}

// The meta fields the context pack masks for a caller with a token (TB-141,
// `forest/context/redact-context.ts`).
const TEXT_FIELDS = ["report", "executor", "branch", "contextPack"] as const;
const LIST_FIELDS = ["pullRequests", "files"] as const;

// TB-141: a caller with a token reads these fields masked in the context
// pack. A write of a text field gets the stored values back in place of the
// markers, by the TB-143 rule (`restoreForTokenCaller`: 409 if the markers do
// not match). A list item has no block to tie a marker to, so an item with a
// marker is refused. The stored row is read once, and only if a field
// carries a marker. The web app's session writes as it reads: no change.
export async function restoreMetaText(
  c: Context,
  taskId: string,
  patch: CardMetaPatch,
): Promise<CardMetaPatch> {
  if (!isTokenCaller(c)) return patch;

  for (const field of LIST_FIELDS) {
    if (patch[field]?.some(hasRedactionMarker)) {
      throw new ApiError(409, {
        code: "REDACTED_MARKERS_MISMATCH",
        message: `An item of ${field} has a [REDACTED:…] marker, and a list item cannot get its stored value back. Leave ${field} out of the change, or ask a person to edit it in the web app.`,
      });
    }
  }

  let stored: ReturnType<typeof loadCardMeta> | undefined;
  const load = () => (stored ??= loadCardMeta(taskId));
  const restored: CardMetaPatch = { ...patch };
  for (const field of TEXT_FIELDS) {
    const value = patch[field];
    if (typeof value !== "string") continue;
    restored[field] = await restoreForTokenCaller(
      c,
      value,
      async () => (await load())?.[field],
    );
  }
  return restored;
}
