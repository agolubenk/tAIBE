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
import { notebookEmbedModel } from "../../notebook-model/effective-notebook-model";
import { addPullRequestSource } from "../sources/github-pr-source";
import { addLinkSource } from "../sources/link-source";
import {
  deleteSources,
  listSources,
  pruneSources,
} from "../sources/list-sources";
import { syncCardSources } from "../sources/sync-card-sources";
import { upsertSource } from "../sources/upsert-source";
import {
  addedSourceSchema,
  addLinkBody,
  addPullRequestBody,
  cardSyncSchema,
  prunedSchema,
  pruneSourcesBody,
  putSourceBody,
  removeSourceBody,
  SOURCE_BODY_BYTES,
  SOURCE_URL_BODY_BYTES,
  sourcesSchema,
  upsertedSourceSchema,
  workspaceParam,
} from "./schema";

const listSourcesRoute = createRoute({
  method: "get",
  operationId: "listNotebookSources",
  path: "/{workspaceId}/sources",
  tags: ["Notebook"],
  summary: "List notebook sources",
  description:
    "Every source in the workspace notebook with its sha256, so a sync uploads only what changed, and how many of its chunks carry a vector.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Notebook sources", sourcesSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const putSourceRoute = createRoute({
  method: "put",
  operationId: "putNotebookSource",
  path: "/{workspaceId}/sources",
  tags: ["Notebook"],
  summary: "Add or replace a notebook source",
  description:
    "Stores the text, cuts it into chunks by headings and queues them for embedding. The same text again changes nothing.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: putSourceBody } },
    },
  },
  responses: {
    200: jsonResponse("Source stored", upsertedSourceSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("Request body is too large"),
  },
});

const pruneSourcesRoute = createRoute({
  method: "post",
  operationId: "pruneNotebookSources",
  path: "/{workspaceId}/sources/prune",
  tags: ["Notebook"],
  summary: "Remove notebook sources that no longer exist",
  description:
    "Deletes every source of the kind whose ref is not in the list, with its chunks.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: pruneSourcesBody } },
    },
  },
  responses: {
    200: jsonResponse("Sources pruned", prunedSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("Request body is too large"),
  },
});

const removeSourceRoute = createRoute({
  method: "post",
  operationId: "removeNotebookSource",
  path: "/{workspaceId}/sources/remove",
  tags: ["Notebook"],
  summary: "Remove one added page or pull request from the notebook",
  description:
    "Deletes one link or github-pr source with its chunks. The synced kinds are refused: their next sync would bring them back. A ref that is already gone answers deleted: 0.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_URL_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: removeSourceBody } },
    },
  },
  responses: {
    200: jsonResponse("Source removed", prunedSchema),
    400: errorResponse("Not a link or github-pr source, or no ref"),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("Request body is too large"),
  },
});

const syncCardsRoute = createRoute({
  method: "post",
  operationId: "syncNotebookCards",
  path: "/{workspaceId}/sources/cards",
  tags: ["Notebook"],
  summary: "Sync the workspace cards into the notebook",
  description:
    "The scheduler runs this every 10 minutes; call it to see a card edit in search sooner. Only cards of active projects that every member may open are kept, since threads are shared by the whole workspace.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Cards synced", cardSyncSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
  },
});

const addLinkRoute = createRoute({
  method: "post",
  operationId: "addNotebookLink",
  path: "/{workspaceId}/sources/link",
  tags: ["Notebook"],
  summary: "Add or refresh a web page in the notebook",
  description:
    "Fetches one https page a member asked for: every redirect hop and the connected address must be public, whatever KANEO_ALLOW_PRIVATE_WEBHOOK_DESTINATIONS says. HTML, Markdown and plain text only, up to 2 MB and 10 seconds. Each refusal carries its own code (LINK_*).",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_URL_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: addLinkBody } },
    },
  },
  responses: {
    200: jsonResponse("Page stored", addedSourceSchema),
    400: errorResponse("Not an https URL"),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("The page, its text or its chunk count is too large"),
    415: errorResponse("Not HTML, Markdown or plain text; PDF is refused"),
    422: errorResponse(
      "Private address, unreachable, timed out, error status or no text",
    ),
  },
});

const addPullRequestRoute = createRoute({
  method: "post",
  operationId: "addNotebookPullRequest",
  path: "/{workspaceId}/sources/github-pr",
  tags: ["Notebook"],
  summary: "Add or refresh a GitHub pull request in the notebook",
  description:
    "Reads the title, description and the first 100 comments through the GitHub App. The repository must be linked by a verified integration of a project every member may open.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_URL_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: addPullRequestBody } },
    },
  },
  responses: {
    200: jsonResponse("Pull request stored", addedSourceSchema),
    400: errorResponse("Not a GitHub pull request URL"),
    403: errorResponse("Missing workspace:manage_settings permission"),
    404: errorResponse("No such pull request in the repository"),
    413: errorResponse("The pull request cuts into too many chunks"),
    422: errorResponse(
      "The repository is not linked to this workspace, or the App may not read it",
    ),
    502: errorResponse("GitHub did not answer"),
    503: errorResponse("The GitHub App is not configured"),
  },
});

export const sourceRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listSourcesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const model = await notebookEmbedModel();
    return c.json(
      { model, sources: await listSources(workspaceId, model) },
      200,
    );
  })
  .openapi(putSourceRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    return c.json(await upsertSource({ workspaceId, ...body }), 200);
  })
  .openapi(pruneSourcesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { kind, keep } = c.req.valid("json");
    return c.json(
      { deleted: await pruneSources(workspaceId, kind, keep) },
      200,
    );
  })
  .openapi(removeSourceRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { kind, ref } = c.req.valid("json");
    return c.json(
      { deleted: await deleteSources(workspaceId, kind, [ref]) },
      200,
    );
  })
  .openapi(syncCardsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(await syncCardSources(workspaceId), 200);
  })
  .openapi(addLinkRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { url } = c.req.valid("json");
    return c.json(await addLinkSource(workspaceId, url), 200);
  })
  .openapi(addPullRequestRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { url } = c.req.valid("json");
    return c.json(await addPullRequestSource(workspaceId, url), 200);
  });
