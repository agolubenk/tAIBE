import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { maskForTokenCaller } from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { getLog } from "../read/get-log";
import { listLogs } from "../read/list-logs";
import { listSectors } from "../read/list-sectors";
import { detectSectors } from "../sector/detect-sectors";
import {
  detectedSectorSchema,
  logParam,
  logQuery,
  logSchema,
  logSummarySchema,
  sectorQuery,
  sectorSchema,
  workspaceParam,
} from "./schema";

const listLogsRoute = createRoute({
  method: "get",
  operationId: "listForestLogs",
  path: "/{workspaceId}/logs",
  tags: ["Forest"],
  summary: "List or search logs",
  description:
    "Felled trees, newest first. `q` searches titles, descriptions and kept history.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: workspaceParam, query: logQuery },
  responses: {
    200: jsonResponse(
      "A page of logs",
      z.object({
        items: z.array(logSummarySchema),
        nextCursor: z.string().nullable(),
      }),
    ),
    400: errorResponse("Invalid cursor"),
  },
});

const getLogRoute = createRoute({
  method: "get",
  operationId: "getForestLog",
  path: "/{workspaceId}/logs/{logId}",
  tags: ["Forest"],
  summary: "Get a log with its seeds",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: logParam },
  responses: {
    200: jsonResponse("The log", logSchema),
    404: errorResponse("Log not found"),
  },
});

const listSectorsRoute = createRoute({
  method: "get",
  operationId: "listForestSectors",
  path: "/{workspaceId}/sectors",
  tags: ["Forest"],
  summary: "List sectors",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: workspaceParam, query: sectorQuery },
  responses: {
    200: jsonResponse("Sectors", z.array(sectorSchema)),
  },
});

const detectSectorsRoute = createRoute({
  method: "post",
  operationId: "detectForestSectors",
  path: "/{workspaceId}/sectors/detect",
  tags: ["Forest"],
  summary: "Detect sectors",
  description:
    "Groups trees joined by blocks/related links. New groups become sectors; groups that fell apart are marked stale.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Current sectors", z.array(detectedSectorSchema)),
    403: errorResponse("Missing task:update permission"),
  },
});

export const readRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listLogsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { q, cursor, take } = c.req.valid("query");
    return c.json(
      maskForTokenCaller(
        c,
        await listLogs({ workspaceId, query: q, cursor, take }),
        ["nextCursor"],
      ),
      200,
    );
  })
  .openapi(getLogRoute, async (c) => {
    const { workspaceId, logId } = c.req.valid("param");
    const log = await getLog(workspaceId, logId);
    return c.json(
      maskForTokenCaller(c, {
        ...log,
        fields: log.fields as Record<string, unknown>,
        history: log.history as Record<string, unknown>[],
      }),
      200,
    );
  })
  .openapi(listSectorsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    return c.json(
      maskForTokenCaller(c, await listSectors(workspaceId, status)),
      200,
    );
  })
  .openapi(detectSectorsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(maskForTokenCaller(c, await detectSectors(workspaceId)), 200);
  });
