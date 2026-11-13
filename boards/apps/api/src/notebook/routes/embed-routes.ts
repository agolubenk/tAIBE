import { HTTPException } from "hono/http-exception";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { markWorkerSeen, waitForEmbedWork } from "../embed/embed-queue";
import { claimEmbedWork, saveEmbeddings } from "../embed/embed-work";
import { notebookEmbedModel } from "../../notebook-model/effective-notebook-model";
import {
  EMBED_RESULTS_BODY_BYTES,
  embedResultsBody,
  embedSavedSchema,
  embedWorkQuery,
  embedWorkSchema,
  workspaceParam,
} from "./schema";

const embedWorkResponses = {
  200: jsonResponse("Embedding work", embedWorkSchema),
  403: errorResponse("Missing workspace:manage_settings permission"),
};

// Taking work leases it: a POST (TB-97), so no GET under /api/notebook
// changes state once the old route is gone.
const takeEmbedWorkRoute = createRoute({
  method: "post",
  operationId: "takeNotebookEmbedWork",
  path: "/{workspaceId}/embed/work",
  tags: ["Notebook"],
  summary: "Take embedding work",
  description:
    "For the embedding worker: search queries waiting for a vector first, then chunks without one for the current model. The items are leased to the caller. With `wait`, an empty answer is held until work arrives.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam, query: embedWorkQuery },
  responses: embedWorkResponses,
});

// The Mac worker runs from a copy (notebook-agent.sh) and keeps calling GET
// until the copy is updated; the GET goes away after that (TB-97 phase 2).
const embedWorkRoute = createRoute({
  method: "get",
  operationId: "getNotebookEmbedWork",
  path: "/{workspaceId}/embed/work",
  tags: ["Notebook"],
  summary: "Take embedding work (deprecated: use POST)",
  description:
    "Deprecated (TB-97): takes and leases work exactly as `POST` does. Kept only for embedding workers older than the `POST` route.",
  deprecated: true,
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam, query: embedWorkQuery },
  responses: embedWorkResponses,
});

// The work of one poll: the worker is seen, then items are leased to it; an
// empty answer waits up to `wait` seconds for work.
async function takeEmbedWork(
  workspaceId: string,
  wait: number,
  signal: AbortSignal,
) {
  let model = await notebookEmbedModel();
  markWorkerSeen(workspaceId);
  let items = await claimEmbedWork(workspaceId, model);
  if (!items.length && wait > 0) {
    await waitForEmbedWork(workspaceId, wait * 1000, signal);
    markWorkerSeen(workspaceId);
    if (!signal.aborted) {
      // The admin may have switched the embedding model during the wait.
      model = await notebookEmbedModel();
      items = await claimEmbedWork(workspaceId, model);
    }
  }
  return { model, items };
}

// Once per workspace and process: enough to see that an old worker copy is
// still running, without a line every 25 seconds.
const oldWorkers = new Set<string>();
function warnOldWorker(workspaceId: string) {
  if (oldWorkers.has(workspaceId)) return;
  oldWorkers.add(workspaceId);
  console.warn(
    `notebook ${workspaceId}: the embedding worker takes work with the deprecated GET (TB-97); update its copy: deploy/vps/mac/notebook-agent.sh install`,
  );
}

const embedResultsRoute = createRoute({
  method: "post",
  operationId: "postNotebookEmbedResults",
  path: "/{workspaceId}/embed/results",
  tags: ["Notebook"],
  summary: "Return embeddings",
  description:
    "For the embedding worker: vectors for the items it took. Ids that are gone meanwhile are skipped.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(EMBED_RESULTS_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: embedResultsBody } },
    },
  },
  responses: {
    200: jsonResponse("Embeddings stored", embedSavedSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    409: errorResponse("Embedded with a model other than the current one"),
    413: errorResponse("Request body is too large"),
  },
});

export const embedRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(takeEmbedWorkRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { wait } = c.req.valid("query");
    return c.json(
      await takeEmbedWork(workspaceId, wait, c.req.raw.signal),
      200,
    );
  })
  .openapi(embedWorkRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { wait } = c.req.valid("query");
    warnOldWorker(workspaceId);
    return c.json(
      await takeEmbedWork(workspaceId, wait, c.req.raw.signal),
      200,
    );
  })
  .openapi(embedResultsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const model = await notebookEmbedModel();
    if (body.model !== model) {
      throw new HTTPException(409, {
        message: `The notebook embeds with ${model}`,
      });
    }
    markWorkerSeen(workspaceId);
    return c.json(await saveEmbeddings(workspaceId, model, body.items), 200);
  });
