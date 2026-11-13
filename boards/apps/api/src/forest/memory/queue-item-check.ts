import { HTTPException } from "hono/http-exception";
import {
  httpQueueClient,
  type QueueClient,
  type QueueDoc,
} from "../owner-queue/queue-client";
import {
  type OwnerQueueConfig,
  readOwnerQueueConfig,
} from "../owner-queue/queue-config";

// Memory is searched by a queue item id only when the workspace is linked to
// the queue (OQ_WORKSPACE_PRODUCTS, as for the sync, TB-102), the item exists,
// the t-boards token sees it and the item belongs to the workspace's product
// (TB-113, C-2): otherwise any word shaped like an id would search the owner's
// memory, and a token that sees two products would show one product's titles
// in the other's workspace. 404 for missing, invisible or foreign, 503 when
// the queue link is off or the queue does not answer.
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
  const product = config?.products.get(workspaceId);
  if (!config || !product) {
    throw new HTTPException(503, { message: "Owner queue is not linked" });
  }
  let doc: QueueDoc | null;
  try {
    doc = await (deps.client ?? httpQueueClient)(config).get("items", id);
  } catch {
    throw new HTTPException(503, { message: "Owner queue did not answer" });
  }
  // The queue sends each document's product; a server without it predates
  // products and holds only the default one (DEFAULT_PRODUCT, hr-helper).
  if (!doc || (doc.product ?? "hr-helper") !== product) {
    throw new HTTPException(404, { message: "Queue item not found" });
  }
}
