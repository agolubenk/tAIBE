import type { Context } from "hono";
import type { SourceAuthorKind } from "../../database/notebook-schema";
import { resolveForestActor } from "../../forest/actor";
import type { BaseVariables } from "../../openapi";

export type SourceAuthor = { kind: SourceAuthorKind; name: string | null };

// The name is shown as it is: an agent's name already carries its session
// («r.ai5m · Claude Code»), a token without an agent identity its session
// label, a member their name (TB-115).
export const SOURCE_AUTHOR_MAX = 200;

export function sourceAuthor<E extends { Variables: BaseVariables }>(
  c: Context<E, any, any>,
): SourceAuthor {
  const actor = resolveForestActor(c);
  if (actor.kind === "agent") {
    return { kind: "agent", name: actor.name.slice(0, SOURCE_AUTHOR_MAX) };
  }
  // A member's actor name falls back to the email (forest/actor.ts). GET
  // /sources shows the author to every member and agent, so a member without
  // a name is stored as a nameless person, never as their email.
  const name = (c.get("user") as { name?: string | null } | null)?.name?.trim();
  return {
    kind: "person",
    name: name ? name.slice(0, SOURCE_AUTHOR_MAX) : null,
  };
}
