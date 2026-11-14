import type { Context } from "hono";
import { ForestError } from "../forest/forest-error";
import type { BaseVariables } from "../openapi";

export type AgentKeyIssuer = {
  ownerId: string;
  // A restricted key passes its limits on: an agent never exceeds its issuer.
  permissions: Record<string, string[]> | null;
  // Nor outlives it.
  expiresAt: Date | null;
};

// Keys for agents come from a person: their browser session or their own
// unscoped key. An agent minting agents, or a one-workspace key minting a key
// that reaches every workspace of its owner, would widen access.
export function agentKeyIssuer<E extends { Variables: BaseVariables }>(
  c: Context<E, any, any>,
): AgentKeyIssuer {
  const apiKey = c.get("apiKey");
  const user = c.get("user") as { role?: string | null } | null;
  if (apiKey?.agent || user?.role === "agent") {
    throw new ForestError(
      "agent_forbidden",
      "an agent cannot issue agent keys; its owner's key does",
    );
  }
  // TB-96 R-016: an agent key carries no access level of its own, so a key
  // from a read-only key would write. Listing and switching agents is account
  // management and stays with a person's session or full key too.
  if (apiKey?.access === "read") {
    throw new ForestError(
      "agent_forbidden",
      "a read-only key cannot issue or manage agent keys",
    );
  }
  const scope = apiKey?.workspaceScope;
  if (scope && scope.kind !== "all") {
    throw new ForestError(
      "agent_forbidden",
      "a key limited to one workspace cannot issue agent keys",
    );
  }
  return {
    ownerId: c.get("userId"),
    permissions: apiKey?.permissions ?? null,
    expiresAt: apiKey?.expiresAt ?? null,
  };
}
