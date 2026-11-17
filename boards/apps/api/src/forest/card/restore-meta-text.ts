import type { Context } from "hono";
import { restoreForTokenCaller } from "../../utils/token-caller-text";
import { loadCardMeta } from "./card-meta";
import type { CardMetaPatch } from "./card-patch";

const FREE_TEXT = ["report", "contextPack"] as const;

/**
 * TB-204: a caller with a token reads the report and the context pack of a
 * card masked. If it sends one back with its [REDACTED:…] markers, the
 * markers get the stored values back, as task text does (TB-143); a changed
 * block with a marker is refused (409). The short fields (severity,
 * executor, branch, links, files) are not restored: a marker there is
 * stored as it came.
 */
export async function restoreMetaText(
  c: Context,
  taskId: string,
  patch: CardMetaPatch,
): Promise<CardMetaPatch> {
  let stored: ReturnType<typeof loadCardMeta> | undefined;
  const load = () => {
    stored ??= loadCardMeta(taskId);
    return stored;
  };
  const restored = { ...patch };
  for (const field of FREE_TEXT) {
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
