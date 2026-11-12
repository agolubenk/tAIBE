import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { BaseVariables } from "../openapi";

// owner-queue is internal: the owner's answer read from the owner queue
// (TB-102 R-3). No HTTP route and no token resolves to it.
export type ForestActorKind =
  | "owner-ui"
  | "member-ui"
  | "agent"
  | "owner-queue";

export type ForestActor = {
  kind: ForestActorKind;
  // Stable per session: the lease holder and the journal actor.
  id: string;
  name: string;
  userId: string;
};

const SESSION_LABEL_HEADER = "x-t-boards-session";
const SESSION_LABEL_PATTERN = /^[\p{L}\p{N} ._:/#-]{1,80}$/u;

function sessionLabel(c: Context): string | null {
  const raw = c.req.header(SESSION_LABEL_HEADER)?.trim();
  return raw && SESSION_LABEL_PATTERN.test(raw) ? raw : null;
}

// The owner's «да» counts only from the owner's own browser session (N-011):
// a cookie session of an instance admin with no bearer token or API key.
// Anything holding a token — API keys, MCP, bearer sessions — is an agent.
export function resolveForestActor<E extends { Variables: BaseVariables }>(
  c: Context<E, any, any>,
): ForestActor {
  const userId = c.get("userId");
  if (!userId) throw new HTTPException(401, { message: "Unauthorized" });

  const apiKey = c.get("apiKey");
  const hasToken =
    Boolean(apiKey) ||
    Boolean(c.req.header("authorization")) ||
    Boolean(c.req.header("x-api-key"));
  const label = sessionLabel(c);

  // R-010: an agent user is one session already; its id outlives key rotation.
  const user = c.get("user");
  const agentName =
    apiKey?.agent?.name ??
    ((user as { role?: string | null } | null)?.role === "agent"
      ? user?.name
      : undefined);
  if (agentName) {
    return { kind: "agent", id: `agent:${userId}`, name: agentName, userId };
  }

  if (hasToken) {
    const base = apiKey ? `key:${apiKey.id}` : `bearer:${userId}`;
    return {
      kind: "agent",
      id: label ? `${base}:${label}` : base,
      name: label ?? base,
      userId,
    };
  }

  const session = c.get("session");
  if (!user || !session) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const isOwner = (user as { role?: string | null }).role === "admin";
  return {
    kind: isOwner ? "owner-ui" : "member-ui",
    id: `session:${session.id}`,
    name: user.name || user.email,
    userId,
  };
}
