import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

// t-boards: R-002, AC-011. A key created with metadata { workspaceId } only
// reaches that workspace (one product). Keys without it keep the user's reach.
export type ApiKeyWorkspaceScope =
  | { kind: "all" }
  | { kind: "workspace"; workspaceId: string }
  // Metadata names a workspace but is unreadable: the key reaches nothing.
  | { kind: "invalid" };

const ALL: ApiKeyWorkspaceScope = { kind: "all" };
const INVALID: ApiKeyWorkspaceScope = { kind: "invalid" };

export function decodeApiKeyMetadata(
  raw: unknown,
): { ok: true; value: unknown } | { ok: false } {
  let value = raw;
  // Better Auth stored some metadata double-stringified; unwrap once more.
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value };
}

export function parseApiKeyWorkspaceScope(
  metadata: unknown,
): ApiKeyWorkspaceScope {
  if (metadata === null || metadata === undefined) return ALL;
  const decoded = decodeApiKeyMetadata(metadata);
  if (!decoded.ok) return INVALID;
  const { value } = decoded;
  if (value === null) return ALL;
  if (typeof value !== "object" || Array.isArray(value)) return INVALID;
  if (!("workspaceId" in value)) return ALL;
  const { workspaceId } = value as { workspaceId: unknown };
  return typeof workspaceId === "string" && workspaceId.trim() !== ""
    ? { kind: "workspace", workspaceId }
    : INVALID;
}

export function scopeAllowsWorkspace(
  scope: ApiKeyWorkspaceScope | undefined,
  workspaceId: string,
): boolean {
  if (!scope || scope.kind === "all") return true;
  return scope.kind === "workspace" && scope.workspaceId === workspaceId;
}

export function isWorkspaceScoped(
  scope: ApiKeyWorkspaceScope | undefined,
): scope is Exclude<ApiKeyWorkspaceScope, { kind: "all" }> {
  return !!scope && scope.kind !== "all";
}

export function requestWorkspaceScope(
  c: Context,
): ApiKeyWorkspaceScope | undefined {
  const apiKey = c.get("apiKey") as
    | { workspaceScope?: ApiKeyWorkspaceScope }
    | undefined;
  return apiKey?.workspaceScope;
}

// 404, not 403: a scoped key must not learn that another workspace exists.
export function assertKeyReachesWorkspace(
  c: Context,
  workspaceId: string,
  notFoundMessage = "Workspace not found",
): void {
  if (!scopeAllowsWorkspace(requestWorkspaceScope(c), workspaceId)) {
    throw new HTTPException(404, { message: notFoundMessage });
  }
}
