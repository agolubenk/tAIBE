import type { Context } from "hono";
import { ApiError } from "../errors/api-error";
import { decodeApiKeyMetadata } from "./api-key-workspace-scope";

// t-boards: TB-96. A key created with metadata { access: "read" } only reads:
// GET and HEAD, every other method gets 403. Keys without the field keep the
// access they had. Any other value, or metadata that cannot be read, also reads
// only: a leaked key must not get more than its owner chose.
export type ApiKeyAccess = "full" | "read";

const READ_METHODS = new Set(["GET", "HEAD"]);

export function parseApiKeyAccess(metadata: unknown): ApiKeyAccess {
  if (metadata === null || metadata === undefined) return "full";
  const decoded = decodeApiKeyMetadata(metadata);
  if (!decoded.ok) return "read";
  const { value } = decoded;
  if (value === null) return "full";
  if (typeof value !== "object" || Array.isArray(value)) return "read";
  if (!("access" in value)) return "full";
  const { access } = value as { access: unknown };
  return access === "full" ? "full" : "read";
}

export function keyAccessAllowsMethod(
  access: ApiKeyAccess | undefined,
  method: string,
): boolean {
  return access !== "read" || READ_METHODS.has(method.toUpperCase());
}

export function requestKeyAccess(c: Context): ApiKeyAccess | undefined {
  const apiKey = c.get("apiKey") as { access?: ApiKeyAccess } | undefined;
  return apiKey?.access;
}

export function assertKeyAccessAllowsMethod(
  access: ApiKeyAccess | undefined,
  method: string,
): void {
  if (keyAccessAllowsMethod(access, method)) return;
  throw new ApiError(403, {
    message: "This API key is read-only",
    code: "API_KEY_READ_ONLY",
  });
}
