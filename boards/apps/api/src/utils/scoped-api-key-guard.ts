import type { Context, Next } from "hono";
import { ApiError } from "../errors/api-error";
import {
  assertKeyAccessAllowsMethod,
  requestKeyAccess,
} from "./api-key-access";
import {
  type ApiKeyWorkspaceScope,
  isWorkspaceScoped,
  requestWorkspaceScope,
  scopeAllowsWorkspace,
} from "./api-key-workspace-scope";
import { apiKeyMayCallAuth } from "./api-key-auth-routes";
import {
  ORGANIZATION_LIST_PATH,
  scopedKeyMayCall,
} from "./scoped-api-key-routes";

function outOfScope() {
  return new ApiError(403, {
    message: "This API key is limited to one workspace",
    code: "API_KEY_WORKSPACE_SCOPE",
  });
}

// Runs after authenticateApiRequest on the regular API routes.
export async function scopedApiKeyGuard(c: Context, next: Next) {
  // TB-96: a read-only key, scoped or not, only reads. The check runs first,
  // so every write by such a key answers API_KEY_READ_ONLY.
  assertKeyAccessAllowsMethod(requestKeyAccess(c), c.req.method);
  if (
    isWorkspaceScoped(requestWorkspaceScope(c)) &&
    !scopedKeyMayCall(c.req.method, c.req.path)
  ) {
    throw outOfScope();
  }
  return next();
}

// Better Auth routes see the key only as a session, so the check runs on the
// verified key before the request reaches the auth handler.
export function assertScopedKeyAuthRoute(
  scope: ApiKeyWorkspaceScope,
  method: string,
  path: string,
): void {
  if (isWorkspaceScoped(scope) && !apiKeyMayCallAuth(method, path)) {
    throw outOfScope();
  }
}

// The organization list is the one auth response that lists workspaces.
export async function limitAuthResponseToScope(
  scope: ApiKeyWorkspaceScope,
  path: string,
  response: Response,
): Promise<Response> {
  if (
    !isWorkspaceScoped(scope) ||
    path.replace(/\/$/, "") !== ORGANIZATION_LIST_PATH ||
    !response.ok
  ) {
    return response;
  }
  const body: unknown = await response.json();
  const visible = Array.isArray(body)
    ? body.filter(
        (organization: { id?: unknown }) =>
          typeof organization?.id === "string" &&
          scopeAllowsWorkspace(scope, organization.id),
      )
    : [];
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(visible), {
    status: response.status,
    headers,
  });
}
