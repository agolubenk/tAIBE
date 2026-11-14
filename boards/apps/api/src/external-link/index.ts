import { eq } from "drizzle-orm";
import db from "../database";
import { externalLinkTable } from "../database/schema";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import {
  maskForTokenCaller,
  refuseMarkerForTokenCaller,
} from "../utils/token-caller-text";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import createExternalLink from "./controllers/create-external-link";
import deleteExternalLink from "./controllers/delete-external-link";
import {
  createdExternalLinkSchema,
  deletedExternalLinkSchema,
  externalLinkListSchema,
} from "./response";
import {
  createExternalLinkBody,
  deleteExternalLinkParam,
  taskIdParam,
} from "./schema";

const createExternalLinkRoute = createRoute({
  method: "post",
  operationId: "createExternalLink",
  path: "/task/{taskId}",
  tags: ["External Links"],
  summary: "Create an external link",
  description: "Add a resource link to a task",
  middleware: [
    workspaceAccess.fromTaskId("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: taskIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createExternalLinkBody,
        },
      },
    },
  },
  responses: {
    200: jsonResponse(
      "External link created successfully",
      createdExternalLinkSchema,
    ),
    400: errorResponse("Invalid external link data"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("No permission to update the task"),
    404: errorResponse("Task not found"),
    409: errorResponse(
      "A caller with a token sent a [REDACTED:kind] marker in the URL or title; a new link has no stored value to restore",
    ),
  },
});

const deleteExternalLinkRoute = createRoute({
  method: "delete",
  operationId: "deleteExternalLink",
  path: "/task/{taskId}/{id}",
  tags: ["External Links"],
  summary: "Remove a manual resource link",
  description:
    "Remove a manually added link from a task. Integration-managed links cannot be removed through this endpoint.",
  middleware: [
    workspaceAccess.fromTaskId("taskId"),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: { params: deleteExternalLinkParam },
  responses: {
    200: jsonResponse("Resource link removed", deletedExternalLinkSchema),
    400: errorResponse("Invalid link data"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("No permission to update the task"),
    404: errorResponse("Task or manual resource link not found"),
  },
});

const getExternalLinksByTaskRoute = createRoute({
  method: "get",
  operationId: "getExternalLinksByTask",
  path: "/task/{taskId}",
  tags: ["External Links"],
  summary: "Get task external links",
  description:
    "Get manually added resource links and links from connected integrations, such as GitHub or Gitea issues.",
  middleware: [workspaceAccess.fromTaskId("taskId")] as const,
  request: { params: taskIdParam },
  responses: {
    200: jsonResponse("External links for the task", externalLinkListSchema),
    403: errorResponse("No access to the project"),
    404: errorResponse("Task not found"),
  },
});

const externalLink = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(createExternalLinkRoute, async (c) => {
    const { taskId } = c.req.valid("param");
    const { url, title } = c.req.valid("json");
    // TB-144: task reads mask link URLs and titles for a caller with a token.
    for (const value of [url, title]) {
      refuseMarkerForTokenCaller(
        c,
        value,
        "Send the full URL and title; a person copies a masked link in the web app.",
      );
    }

    const link = await createExternalLink({
      taskId,
      url,
      title,
      userId: c.get("userId"),
    });

    return c.json(
      maskForTokenCaller(c, {
        ...link,
        metadata: link.metadata ? JSON.parse(link.metadata) : null,
      }),
      200,
    );
  })
  .openapi(deleteExternalLinkRoute, async (c) => {
    const { taskId, id } = c.req.valid("param");
    return c.json(
      maskForTokenCaller(
        c,
        await deleteExternalLink({ taskId, id, userId: c.get("userId") }),
      ),
      200,
    );
  })
  .openapi(getExternalLinksByTaskRoute, async (c) => {
    const { taskId } = c.req.valid("param");

    const links = await db.query.externalLinkTable.findMany({
      where: eq(externalLinkTable.taskId, taskId),
      with: {
        // Never widen this: integration.config holds plaintext provider
        // secrets and this route is reachable by any workspace member.
        integration: { columns: { id: true, type: true } },
      },
    });

    return c.json(
      maskForTokenCaller(
        c,
        links.map((link) => ({
          ...link,
          metadata: link.metadata ? JSON.parse(link.metadata) : null,
        })),
      ),
      200,
    );
  });

export default externalLink;
