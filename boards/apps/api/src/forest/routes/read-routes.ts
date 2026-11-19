import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import {
  isTokenCaller,
  maskForTokenCaller,
} from "../../utils/token-caller-text";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { getLog } from "../read/get-log";
import { listLogs } from "../read/list-logs";
import { listSectors } from "../read/list-sectors";
import { shownComment, uncutClips } from "../read/uncut-text";
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
    "Felled trees, newest first. `q` searches titles, descriptions and kept history. For a caller with a token a page may hold fewer items than `take`, or none, while `nextCursor` is set: logs that match only inside a secret are skipped. Page on until `nextCursor` is null.",
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
    // TB-196: a caller with a token reads logs masked, as task text (TB-143).
    // The cursor is base64 that redact reads as a key, so it stays as is.
    const page = await listLogs({
      workspaceId,
      query: q,
      cursor,
      take,
      tokenCaller: isTokenCaller(c),
    });
    return c.json({ ...page, items: maskForTokenCaller(c, page.items) }, 200);
  })
  .openapi(getLogRoute, async (c) => {
    const { workspaceId, logId } = c.req.valid("param");
    const log = await getLog(workspaceId, logId);
    const tokenCaller = isTokenCaller(c);
    // Claude #388 B2: a seed hash is of the raw body. With the masked body
    // and the rest of the text known, it would check a guess at a secret.
    // TB-203: felling cuts a history entry at HISTORY_CONTENT_CHARS (N3), a
    // seed's description and comments and its body, maybe inside a secret
    // that redact then does not know.
    const seeds = tokenCaller
      ? log.seeds.map(({ contentHash: _hash, ...seed }) => ({
          ...seed,
          body: uncutClips(seed.body),
        }))
      : log.seeds;
    const history = (log.history as Record<string, unknown>[]).map((entry) =>
      tokenCaller && typeof entry.content === "string"
        ? { ...entry, content: shownComment(entry.content) }
        : entry,
    );
    return c.json(
      maskForTokenCaller(c, {
        ...log,
        seeds,
        fields: log.fields as Record<string, unknown>,
        history,
      }),
      200,
    );
  })
  .openapi(listSectorsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    return c.json(await listSectors(workspaceId, status), 200);
  })
  .openapi(detectSectorsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(await detectSectors(workspaceId), 200);
  });
