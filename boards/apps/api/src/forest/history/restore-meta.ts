import type { ForestActor } from "../actor";
import type { AgentHeaders } from "../agent-guard/agent-headers";
import { toCardMeta } from "../card/card-meta";
import { cardMetaPatch } from "../card/card-patch";
import { setCardMeta } from "../card/set-card-meta";
import { ForestError } from "../forest-error";
import { decideRollback, type HistoryChanges } from "./decide-rollback";
import { currentMetaFields } from "./history-fields";
import db from "../../database";

const FIXED = {
  notionPageId: "mirror fields come from Notion; the next import sets them",
  notionStatus: "mirror fields come from Notion; the next import sets them",
};

// A card without a row has the defaults, as the history trigger assumes.
function defaultFields(taskId: string): Record<string, unknown> {
  const {
    taskId: _,
    updatedBy,
    updatedAt,
    mirrored,
    ...fields
  } = toCardMeta(taskId);
  return fields;
}

// Undoes one change of the card fields through the usual write, so its rules
// hold: half-baked moves only from the owner's session, a mirrored card keeps
// its Notion fields.
export async function restoreMeta(input: {
  taskId: string;
  workspaceId: string;
  changes: HistoryChanges;
  actor: ForestActor;
  headers: AgentHeaders;
}) {
  const { taskId } = input;
  const current =
    (await currentMetaFields(db, taskId)) ?? defaultFields(taskId);
  const decision = decideRollback(input.changes, current, FIXED);
  if (!decision.ok) throw new ForestError("history_conflict", decision.reason);
  const patch = cardMetaPatch.safeParse(decision.restore);
  if (!patch.success) {
    throw new ForestError(
      "history_conflict",
      "the recorded values no longer fit the card fields",
    );
  }
  return setCardMeta({
    workspaceId: input.workspaceId,
    taskId,
    actor: input.actor,
    headers: input.headers,
    patch: patch.data,
  });
}
