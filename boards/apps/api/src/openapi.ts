import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Session, User } from "better-auth/types";
import { apiErrorSchema } from "./errors/api-error-schema";
import type { ApiKeyAccess } from "./utils/api-key-access";
import type { ApiKeyWorkspaceScope } from "./utils/api-key-workspace-scope";
import { validationHook } from "./errors/validation-error";

export { createRoute } from "@hono/zod-openapi";
export { z };

export type ApiKey = {
  id: string;
  userId: string;
  enabled: boolean;
  permissions: Record<string, string[]> | null;
  workspaceScope?: ApiKeyWorkspaceScope;
  access?: ApiKeyAccess;
  // R-010: set when the key belongs to an agent user; it acts under this name.
  agent?: { name: string } | null;
  expiresAt?: Date | null;
};

export type BaseVariables = {
  userId: string;
  userEmail: string;
  user: User | null;
  session: Session | null;
  apiKey?: ApiKey;
};

// createRoute({ middleware }) registers middleware BEFORE the request
// validators, so middleware must read the raw request, not c.req.valid().
export function apiRouter<V extends BaseVariables = BaseVariables>() {
  return new OpenAPIHono<{ Variables: V }>({ defaultHook: validationHook });
}

export const pagingNumber = (min: number, max: number, fallback?: number) => {
  const parsed = z
    .string()
    .regex(/^\d+$/, "Expected a positive integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
  return fallback === undefined
    ? parsed.openapi({ type: "integer", minimum: min, maximum: max })
    : parsed.default(fallback).openapi({
        type: "integer",
        minimum: min,
        maximum: max,
        default: fallback,
      });
};

export const responseTimestamp = z
  .date()
  .openapi({ type: "string", format: "date-time" });

export const nullableResponseTimestamp = responseTimestamp
  .nullable()
  .openapi({ type: ["string", "null"], format: "date-time" });

// Declaring a non-2xx response widens an untagged InferResponseType on the
// frontend, so those call sites must tag the status: InferResponseType<T, 200>.
export function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: apiErrorSchema } },
  };
}

export function jsonResponse<T extends z.ZodType>(
  description: string,
  schema: T,
) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}
