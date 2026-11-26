import { ApiError } from "../../errors/api-error";
import type { ForestActor } from "../actor";
import { isAgentAuthored } from "../agent-guard/agent-authored";
import type { AgentHeaders } from "../agent-guard/agent-headers";
import { assertAgentLease } from "../agent-guard/assert-agent-lease";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { isMirroredCard } from "./card-mirror";
import {
  type CardMetaRow,
  loadCardMeta,
  metaRevision,
  toCardMeta,
} from "./card-meta";
import { type CardMetaPatch, patchFields } from "./card-patch";
import { decideCardWrite } from "./decide-card-write";
import { writeCardMeta } from "./write-card-meta";

export const CARD_META_ACTION = "card.meta";

export async function setCardMeta(input: {
  workspaceId: string;
  taskId: string;
  actor: ForestActor;
  headers: AgentHeaders;
  patch: CardMetaPatch;
  // TB-239: puts stored values back into markers the writer sent (TB-204),
  // after the lease check and against the row this write decides on.
  restore?: (stored: CardMetaRow | undefined) => Promise<CardMetaPatch>;
  // TB-142: the revision the writer read; undefined — no check.
  expectedRevision?: string | null;
}) {
  const { workspaceId, taskId, actor, expectedRevision } = input;
  const fields = patchFields(input.patch);
  let patch = input.patch;
  const journal = (outcome: "allowed" | "denied", detail: string) =>
    actor.kind === "agent"
      ? writeJournal({
          workspaceId,
          actor,
          action: CARD_META_ACTION,
          targetType: "task",
          targetId: taskId,
          outcome,
          detail,
        })
      : Promise.resolve();

  try {
    if (actor.kind === "agent") {
      await assertAgentLease(actor, taskId, input.headers);
    }
    const current = await loadCardMeta(taskId);
    const decision = decideCardWrite(fields, {
      actorKind: actor.kind,
      mirrored: isMirroredCard(workspaceId, current?.notionPageId),
      agentAuthored: actor.kind === "agent" && (await isAgentAuthored(taskId)),
    });
    if (!decision.ok) throw new ForestError(decision.code, decision.message);
    if (input.restore) {
      patch = await restoreAt(input.restore, current, expectedRevision);
    }
  } catch (error) {
    if (error instanceof ForestError) await journal("denied", error.message);
    throw error;
  }

  const row = await writeCardMeta({
    taskId,
    workspaceId,
    patch,
    actorId: actor.id,
    expectedRevision,
  });
  if (!row) {
    // Someone else (the owner in the UI holds no lease) wrote in between.
    const error = revisionConflict(
      await loadCardMeta(taskId),
      expectedRevision,
    );
    await journal("denied", error.message);
    throw error;
  }
  await journal("allowed", fields.join(","));
  return toCardMeta(taskId, row);
}

// TB-239: a writer that read the fields before someone changed them sends
// markers of the old text. They do not match the new text, but the cause is
// the revision: the writer reads again, its markers are not at fault.
async function restoreAt(
  restore: (stored: CardMetaRow | undefined) => Promise<CardMetaPatch>,
  stored: CardMetaRow | undefined,
  expectedRevision: string | null | undefined,
) {
  try {
    return await restore(stored);
  } catch (error) {
    const mismatch =
      error instanceof ApiError && error.code === "REDACTED_MARKERS_MISMATCH";
    if (mismatch && moved(stored, expectedRevision)) {
      throw revisionConflict(stored, expectedRevision);
    }
    throw error;
  }
}

// The revision as the conditional write compares it: updated_at to the
// millisecond; null — no row yet (write-card-meta).
function moved(
  stored: CardMetaRow | undefined,
  expectedRevision: string | null | undefined,
) {
  if (expectedRevision === undefined) return false;
  const at = stored ? metaRevision(stored.updatedAt) : null;
  const read =
    expectedRevision === null ? null : metaRevision(new Date(expectedRevision));
  return at !== read;
}

function revisionConflict(
  stored: CardMetaRow | undefined,
  expectedRevision: string | null | undefined,
) {
  const at = stored ? metaRevision(stored.updatedAt) : "none";
  return new ForestError(
    "revision_conflict",
    `card fields are at revision ${at}, not ${expectedRevision ?? "none"}; read them again`,
  );
}
