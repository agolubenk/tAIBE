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
import {
  embedWorkGeneration,
  markWorkerSeen,
  waitForEmbedWork,
} from "../embed/embed-queue";
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

const embedWorkRoute = createRoute({
  method: "get",
  operationId: "getNotebookEmbedWork",
  path: "/{workspaceId}/embed/work",
  tags: ["Notebook"],
  summary: "Take embedding work",
  description:
    "For the embedding worker: search queries waiting for a vector first, then chunks without one for the current model. With `wait`, an empty answer is held until work arrives.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam, query: embedWorkQuery },
  responses: {
    200: jsonResponse("Embedding work", embedWorkSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
  },
});

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
  .openapi(embedWorkRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { wait } = c.req.valid("query");
    let model = await notebookEmbedModel();
    markWorkerSeen(workspaceId);
    // Read before the claim: work that arrives while the claim waits for the
    // database must wake this poll, not find nobody parked (TB-212).
    const seen = embedWorkGeneration(workspaceId);
    let items = await claimEmbedWork(workspaceId, model);
    if (!items.length && wait > 0) {
      await waitForEmbedWork(workspaceId, wait * 1000, c.req.raw.signal, seen);
      markWorkerSeen(workspaceId);
      if (!c.req.raw.signal.aborted) {
        // The admin may have switched the embedding model during the wait.
        model = await notebookEmbedModel();
        items = await claimEmbedWork(workspaceId, model);
      }
    }
    return c.json({ model, items }, 200);
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
