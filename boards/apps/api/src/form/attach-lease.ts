import type { Context } from "hono";
import type { ForestActor } from "../forest/actor";
import { readAgentHeaders } from "../forest/agent-guard/agent-headers";
import { assertAgentLease } from "../forest/agent-guard/assert-agent-lease";
import { ForestError } from "../forest/forest-error";
import { writeJournal } from "../forest/journal";

export const ATTACH_FORM_ACTION = "form.attach";

/**
 * AC-010 (TB-173): an agent attaches a form to a task only under its live
 * lease on that task, as every other agent write on a task
 * (forest/agent-guard/task-guard.ts). A person needs no lease. The journal
 * gets the agent's attempt either way, as for card fields (set-card-meta.ts).
 */
export async function withAttachLease<T extends { id: string }>(
  c: Context,
  at: { actor: ForestActor; taskId: string; workspaceId: string },
  attach: () => Promise<T>,
): Promise<T> {
  const { actor, taskId, workspaceId } = at;
  if (actor.kind !== "agent") return attach();
  const journal = (outcome: "allowed" | "denied", detail: string) =>
    writeJournal({
      workspaceId,
      actor,
      action: ATTACH_FORM_ACTION,
      targetType: "task",
      targetId: taskId,
      outcome,
      detail,
    });
  try {
    await assertAgentLease(actor, taskId, readAgentHeaders(c));
  } catch (error) {
    if (error instanceof ForestError) await journal("denied", error.message);
    throw error;
  }
  const attached = await attach();
  await journal("allowed", `form ${attached.id}`);
  return attached;
}
