import { HTTPException } from "hono/http-exception";
import { listMirrorRuns } from "../../import/notion-mirror/list-mirror-runs";
import { readMirrorConfig } from "../../import/notion-mirror/mirror-config";
import { startManualMirror } from "../../import/notion-mirror/run-notion-mirror";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { maskForTokenCaller } from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { mirrorRunStartedSchema, mirrorRunsSchema } from "./mirror-schema";
import { workspaceParam } from "./schema";

const listMirrorRunsRoute = createRoute({
  method: "get",
  operationId: "listForestMirrorRuns",
  path: "/{workspaceId}/mirror/runs",
  tags: ["Forest"],
  summary: "List Notion mirror runs",
  description:
    "The scheduled Notion mirror's recent runs, the newest finished run's reconciliation report, and the current streak of clean runs.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Mirror runs", mirrorRunsSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const startMirrorRunRoute = createRoute({
  method: "post",
  operationId: "startForestMirrorRun",
  path: "/{workspaceId}/mirror/runs",
  tags: ["Forest"],
  summary: "Run the Notion mirror now",
  description:
    "Starts one mirror run outside the schedule and returns its id; the run finishes in the background.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    202: jsonResponse("Run started", mirrorRunStartedSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    404: errorResponse("The mirror is not configured for this workspace"),
    409: errorResponse("A mirror run is already in progress"),
  },
});

export const mirrorRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listMirrorRunsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(
      maskForTokenCaller(c, await listMirrorRuns(workspaceId)),
      200,
    );
  })
  .openapi(startMirrorRunRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const config = readMirrorConfig();
    if (config?.workspaceId !== workspaceId) {
      throw new HTTPException(404, {
        message: "The Notion mirror is not configured for this workspace",
      });
    }
    const runId = await startManualMirror(config);
    if (!runId) {
      throw new HTTPException(409, {
        message: "A Notion mirror run is already in progress",
      });
    }
    return c.json({ runId }, 202);
  });
