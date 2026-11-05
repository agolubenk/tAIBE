// t-boards: R-002, AC-011. A workspace-scoped key may only call routes that
// resolve the workspace before the handler runs (workspaceAccess or an explicit
// scope check), so the scope check in validateWorkspaceAccess sees every call.
// Everything else (notifications, invitations, admin, integrations, WebSockets,
// and Better Auth, where a key could mint or widen keys) is refused.
// A new module under one of these prefixes must resolve its workspace too.
const WORKSPACE_RESOLVED_PREFIXES = [
  "/api/activity",
  "/api/column",
  "/api/comment",
  "/api/config",
  "/api/custom-field",
  "/api/external-link",
  "/api/forest",
  "/api/import",
  "/api/label",
  "/api/notebook",
  // Hooks read their product's switches with a key limited to that product (d-tb-product-key-0411); both routes
  // run workspaceAccess.fromParam(), and the update also needs a user session, so a key still cannot change them.
  "/api/pipeline-settings",
  "/api/project",
  "/api/search",
  "/api/task",
  "/api/task-relation",
  "/api/time-entry",
  "/api/workflow-rule",
  "/api/workspace",
] as const;

const USER_ROUTES = new Set(["GET /api/user/me"]);

export const ORGANIZATION_LIST_PATH = "/api/auth/organization/list";

function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function scopedKeyMayCall(method: string, rawPath: string): boolean {
  const path = normalize(rawPath);
  if (USER_ROUTES.has(`${method.toUpperCase()} ${path}`)) return true;
  return WORKSPACE_RESOLVED_PREFIXES.some((prefix) =>
    underPrefix(path, prefix),
  );
}
