import type { TFunction } from "i18next";
import { HttpError } from "@/lib/http-error";

// The API's order (TB-156): not the owner → 403, no queue configured → 404
// owner_queue_off, the console down → 502. A 404 on one document without
// owner_queue_off means the document is gone.
export function ownerQueueErrorText(error: unknown, t: TFunction) {
  if (!(error instanceof HttpError)) return undefined;
  if (error.status === 403) return t("workspace:forest.queue.error.forbidden");
  if (error.status === 404) {
    return error.message.startsWith("owner_queue_off")
      ? t("workspace:forest.queue.error.off")
      : t("workspace:forest.queue.error.notFound");
  }
  if (error.status === 502) {
    return t("workspace:forest.queue.error.unavailable");
  }
  return undefined;
}
