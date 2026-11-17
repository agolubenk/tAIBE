import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { isTokenCaller, maskForTokenCaller } from "../utils/token-caller-text";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import globalSearch from "./controllers/global-search";
import {
  TOKEN_CALLER_SCAN_BYTES,
  TOKEN_CALLER_SCAN_ROWS,
} from "./controllers/visible-rows";
import { searchResponseSchema } from "./response";
import { searchQuery } from "./schema";

const globalSearchRoute = createRoute({
  method: "get",
  operationId: "globalSearch",
  path: "/",
  tags: ["Search"],
  summary: "Global search",
  description:
    "Search across tasks, projects, workspaces, comments, and activities in one workspace. Results are ranked by relevance and returned as a single flat list, each entry tagged with its `type`.\n\n" +
    "A caller with an API key reads text with secrets masked, so a match counts only in that text: a query found only inside a secret returns nothing, and a query with a `[REDACTED:` marker returns an empty list. " +
    `Such a caller gets the matches among the ${TOKEN_CALLER_SCAN_ROWS} newest candidates of each type, at most ${TOKEN_CALLER_SCAN_BYTES / 1024 / 1024} MiB of their text, so a page shorter than \`limit\` does not mean that no other matches exist; narrow the query to find older ones.`,
  middleware: [workspaceAccess.fromQuery()] as const,
  request: { query: searchQuery },
  responses: {
    200: jsonResponse("Ranked search results", searchResponseSchema),
    400: errorResponse(
      "Invalid query, or workspace ID could not be determined",
    ),
    404: errorResponse("Workspace not found"),
  },
});

const search = apiRouter().openapi(globalSearchRoute, async (c) => {
  const { q, type, workspaceId, projectId, limit, userEmail } =
    c.req.valid("query");

  return c.json(
    maskForTokenCaller(
      c,
      await globalSearch({
        query: q,
        userId: c.get("userId"),
        userEmail,
        type,
        workspaceId,
        projectId,
        limit,
        tokenCaller: isTokenCaller(c),
      }),
    ),
    200,
  );
});

export default search;
