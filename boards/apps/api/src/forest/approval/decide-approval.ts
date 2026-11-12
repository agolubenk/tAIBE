import { HTTPException } from "hono/http-exception";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { decideAndApply } from "./decide-and-apply";

// N-011: a decision is accepted only from the owner's session. An agent key
// that tries to answer its own request is refused and the attempt journaled.
// «Да» applies the request at once (TB-102 R-12): the answer comes back as
// consumed, or as failed with the reason the target refused.
export async function decideApproval({
  approvalId,
  workspaceId,
  decision,
  actor,
}: {
  approvalId: string;
  workspaceId: string;
  decision: "approved" | "rejected";
  actor: ForestActor;
}) {
  if (actor.kind !== "owner-ui") {
    await writeJournal({
      workspaceId,
      actor,
      action: "approval.decide",
      targetType: "approval",
      targetId: approvalId,
      outcome: "denied",
      detail: "owner session required (N-011)",
    });
    throw new ForestError(
      "owner_session_required",
      "only the owner's own session can answer an approval",
    );
  }

  const outcome = await decideAndApply({
    approvalId,
    workspaceId,
    decision,
    actor,
    answer: { via: "ui", answeredAt: new Date(), answeredBy: actor.name },
  });
  if (outcome.kind === "not_pending") {
    throw new HTTPException(409, {
      message: "Approval is not pending (answered, applied, failed or expired)",
    });
  }
  return outcome.approval;
}
