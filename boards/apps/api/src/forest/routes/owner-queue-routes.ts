import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { resolveForestActor } from "../actor";
import {
  assertOwnerQueueReader,
  listOwnerQueue,
  OwnerQueueListCache,
  readOwnerQueueDoc,
} from "../owner-queue/owner-queue-view";
import { httpQueueClient } from "../owner-queue/queue-client";
import { readOwnerQueueConfig } from "../owner-queue/queue-config";
import {
  ownerQueueDocParam,
  ownerQueueDocSchema,
  ownerQueueListParam,
  ownerQueueListQuery,
  ownerQueueListSchema,
} from "./owner-queue-schema";

const OWNER_ONLY = "Not the owner's session (agents, API keys and members)";

const listOwnerQueueRoute = createRoute({
  method: "get",
  operationId: "listForestOwnerQueue",
  path: "/{workspaceId}/owner-queue/{collection}",
  tags: ["Forest"],
  summary: "List the owner queue",
  description:
    "The owner queue from the ops-console, read only and for the owner's session alone: 50 documents a page, newest first. Items can be filtered to open or answered by the console's own rule.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: ownerQueueListParam, query: ownerQueueListQuery },
  responses: {
    200: jsonResponse("Owner queue page", ownerQueueListSchema),
    403: errorResponse(OWNER_ONLY),
    404: errorResponse("The owner queue is not configured"),
    502: errorResponse("The ops-console did not answer"),
  },
});

const getOwnerQueueDocRoute = createRoute({
  method: "get",
  operationId: "getForestOwnerQueueDoc",
  path: "/{workspaceId}/owner-queue/{collection}/{id}",
  tags: ["Forest"],
  summary: "Read one owner queue document",
  description:
    "One document with its journal; an item also comes with the owner's answer and its attachments' metadata.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: ownerQueueDocParam },
  responses: {
    200: jsonResponse("Owner queue document", ownerQueueDocSchema),
    403: errorResponse(OWNER_ONLY),
    404: errorResponse("Not configured, or no such document"),
    502: errorResponse("The ops-console did not answer"),
  },
});

const cache = new OwnerQueueListCache();

function queueOrOff() {
  const config = readOwnerQueueConfig();
  if (!config) {
    throw new HTTPException(404, {
      message: "owner_queue_off: the owner queue is not configured",
    });
  }
  return {
    client: httpQueueClient(config),
    queueUrl: `${config.url}/queue`,
    // Queue and plan products of the mapped workspaces: the ones an item id
    // may name (d-taibe-… → taibe).
    knownProducts: [
      ...new Set([
        ...config.products.values(),
        ...config.plan.products.values(),
      ]),
    ],
  };
}

// A console failure is a 502 with the request and status only: no token, no body.
async function fromConsole<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new HTTPException(502, {
      message: `owner_queue_unavailable: ${reason}`,
    });
  }
}

export const ownerQueueRoutes = apiRouter<
  BaseVariables & { workspaceId: string }
>()
  .openapi(listOwnerQueueRoute, async (c) => {
    assertOwnerQueueReader(resolveForestActor(c));
    const { collection } = c.req.valid("param");
    const { state, product, page } = c.req.valid("query");
    const { client, queueUrl, knownProducts } = queueOrOff();
    const list = await fromConsole(() =>
      listOwnerQueue(client, cache, {
        collection,
        state: state ?? "open",
        product,
        page: page ?? 1,
        knownProducts,
      }),
    );
    return c.json({ ...list, queueUrl }, 200);
  })
  .openapi(getOwnerQueueDocRoute, async (c) => {
    assertOwnerQueueReader(resolveForestActor(c));
    const { collection, id } = c.req.valid("param");
    const { client, queueUrl } = queueOrOff();
    const view = await fromConsole(() =>
      readOwnerQueueDoc(client, collection, id),
    );
    return c.json({ ...view, queueUrl }, 200);
  });
