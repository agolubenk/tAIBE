import type { ForestActor } from "../actor";
import { isAgentAuthored } from "../agent-guard/agent-authored";
import type { AgentHeaders } from "../agent-guard/agent-headers";
import { assertAgentLease } from "../agent-guard/assert-agent-lease";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { loadCardMeta, toCardMeta } from "./card-meta";
import { type CardMetaPatch, patchFields } from "./card-patch";
import { decideCardWrite } from "./decide-card-write";
import { isMirrorActive } from "./mirror-active";
import { writeCardMeta } from "./write-card-meta";

export const CARD_META_ACTION = "card.meta";

export async function setCardMeta(input: {
  workspaceId: string;
  taskId: string;
  actor: ForestActor;
  headers: AgentHeaders;
  patch: CardMetaPatch;
}) {
  const { workspaceId, taskId, actor } = input;
  const fields = patchFields(input.patch);
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

  let mirrorActive = false;
  try {
    if (actor.kind === "agent") {
      await assertAgentLease(actor, taskId, input.headers);
    }
    mirrorActive = isMirrorActive(workspaceId);
    const current = await loadCardMeta(taskId);
    const decision = decideCardWrite(fields, {
      actorKind: actor.kind,
      mirrored: mirrorActive && Boolean(current?.notionPageId),
      agentAuthored: actor.kind === "agent" && (await isAgentAuthored(taskId)),
    });
    if (!decision.ok) throw new ForestError(decision.code, decision.message);
  } catch (error) {
    if (error instanceof ForestError) await journal("denied", error.message);
    throw error;
  }

  const row = await writeCardMeta({
    taskId,
    workspaceId,
    patch: input.patch,
    actorId: actor.id,
  });
  await journal("allowed", fields.join(","));
  return toCardMeta(taskId, row, mirrorActive);
}
