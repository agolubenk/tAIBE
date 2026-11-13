import { HTTPException } from "hono/http-exception";
import { httpQueueClient, type QueueClient } from "../owner-queue/queue-client";
import {
  type OwnerQueueConfig,
  readOwnerQueueConfig,
} from "../owner-queue/queue-config";

// Memory is searched by a queue item id only when the workspace is linked to
// the queue (OQ_WORKSPACE_PRODUCTS, as for the sync, TB-102), the item exists
// and the t-boards token sees it (TB-113, C-2): otherwise any word shaped like
// an id would search the owner's memory. 404 for missing or invisible, 503
// when the queue link is off or the queue does not answer.
export async function assertQueueItemVisible(
  workspaceId: string,
  id: string,
  deps: {
    config?: OwnerQueueConfig | null;
    client?: (config: OwnerQueueConfig) => QueueClient;
  } = {},
): Promise<void> {
  const config =
    deps.config === undefined ? readOwnerQueueConfig() : deps.config;
  if (!config?.products.has(workspaceId)) {
    throw new HTTPException(503, { message: "Owner queue is not linked" });
  }
  let doc: unknown;
  try {
    doc = await (deps.client ?? httpQueueClient)(config).get("items", id);
  } catch {
    throw new HTTPException(503, { message: "Owner queue did not answer" });
  }
  if (!doc) {
    throw new HTTPException(404, { message: "Queue item not found" });
  }
}
