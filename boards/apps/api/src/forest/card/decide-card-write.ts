import type { ForestActorKind } from "../actor";
import type { ForestErrorCode } from "../forest-error";
import { type CardField, isNotionField } from "./card-fields";

export type CardWriteContext = {
  actorKind: ForestActorKind;
  mirrored: boolean;
  agentAuthored: boolean;
};

export type CardWriteDecision =
  | { ok: true }
  | { ok: false; code: ForestErrorCode; message: string };

// Who may change which card fields. The agent's lease is checked before this.
// Half-baked is the owner's gate on taking a card into work (Q-011), so only
// the owner's own session moves it, either way.
export function decideCardWrite(
  fields: CardField[],
  ctx: CardWriteContext,
): CardWriteDecision {
  const notion = fields.filter(isNotionField);
  if (ctx.mirrored && notion.length > 0) {
    return {
      ok: false,
      code: "mirror_read_only",
      message: `${notion.join(", ")} are read-only while the Notion mirror runs (R-081)`,
    };
  }
  if (fields.includes("halfBaked") && ctx.actorKind !== "owner-ui") {
    return {
      ok: false,
      code: "owner_session_required",
      message: "only the owner's own session marks or clears a half-baked idea",
    };
  }
  if (ctx.actorKind === "agent" && notion.length > 0 && !ctx.agentAuthored) {
    return {
      ok: false,
      code: "agent_forbidden",
      message: `${notion.join(", ")} of the owner's card stay as the owner set them; comment instead`,
    };
  }
  return { ok: true };
}
