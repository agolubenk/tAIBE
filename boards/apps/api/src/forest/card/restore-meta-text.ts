import type { Context } from "hono";
import { restoreForTokenCaller } from "../../utils/token-caller-text";
import type { CardMetaRow } from "./card-meta";
import type { CardMetaPatch } from "./card-patch";

const FREE_TEXT = ["report", "contextPack"] as const;

/**
 * TB-204: a caller with a token reads the report and the context pack of a
 * card masked. If it sends one back with its [REDACTED:…] markers, the
 * markers get the stored values back, as task text does (TB-143); a changed
 * block with a marker is refused (409). The short fields (severity,
 * executor, branch, links, files) are not restored: a marker there is
 * stored as it came.
 *
 * TB-239: `stored` is the row setCardMeta loaded after the lease check, so
 * the markers are restored against the fields it decides on.
 */
export async function restoreMetaText(
  c: Context,
  patch: CardMetaPatch,
  stored: CardMetaRow | undefined,
): Promise<CardMetaPatch> {
  const restored = { ...patch };
  for (const field of FREE_TEXT) {
    const value = patch[field];
    if (typeof value !== "string") continue;
    restored[field] = await restoreForTokenCaller(
      c,
      value,
      async () => stored?.[field],
    );
  }
  return restored;
}
