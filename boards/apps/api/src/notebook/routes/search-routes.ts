import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import {
  isTokenCaller,
  maskForTokenCaller,
} from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { searchNotebook } from "../search/search-notebook";
import { notebookStatus } from "../status/notebook-status";
import {
  notebookStatusSchema,
  SEARCH_BODY_BYTES,
  searchBody,
  searchResultsSchema,
  workspaceParam,
} from "./schema";

const searchRoute = createRoute({
  method: "post",
  operationId: "searchNotebook",
  path: "/{workspaceId}/search",
  tags: ["Notebook"],
  summary: "Search the notebook",
  description:
    "Ranks chunks by words and, while the embedding worker is online, by meaning too. Falls back to words alone within a few seconds if the worker does not answer.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
    boundedRequestBody(SEARCH_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: searchBody } },
    },
  },
  responses: {
    200: jsonResponse("Search results", searchResultsSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const statusRoute = createRoute({
  method: "get",
  operationId: "getNotebookStatus",
  path: "/{workspaceId}/status",
  tags: ["Notebook"],
  summary: "Notebook status",
  description:
    "How many sources and chunks the notebook holds, how many carry a vector, and whether the embedding worker is online.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Notebook status", notebookStatusSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

export const searchRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(searchRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { query, limit, mode } = c.req.valid("json");
    // TB-196: a caller with a token reads chunks masked, as task text
    // (TB-143); card descriptions are chunks too.
    const found = await searchNotebook({
      workspaceId,
      query,
      limit: limit ?? 8,
      mode: mode ?? "hybrid",
      tokenCaller: isTokenCaller(c),
    });
    return c.json(maskForTokenCaller(c, found), 200);
  })
  .openapi(statusRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(await notebookStatus(workspaceId), 200);
  });
