import type { Context } from "hono";
import type { SourceAuthorKind } from "../../database/notebook-schema";
import { resolveForestActor } from "../../forest/actor";
import type { BaseVariables } from "../../openapi";

export type SourceAuthor = { kind: SourceAuthorKind; name: string };

// The name is shown as it is: an agent's name already carries its session
// («r.ai5m · Claude Code»), a token without an agent identity its session
// label, a member their name (TB-115).
export const SOURCE_AUTHOR_MAX = 200;

export function sourceAuthor<E extends { Variables: BaseVariables }>(
  c: Context<E, any, any>,
): SourceAuthor {
  const actor = resolveForestActor(c);
  return {
    kind: actor.kind === "agent" ? "agent" : "person",
    name: actor.name.slice(0, SOURCE_AUTHOR_MAX),
  };
}
