import type { ForestActor } from "../actor";
import type { AgentHeaders } from "../agent-guard/agent-headers";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { loadAutofillOf, loadHistoryEntry } from "./card-history";
import { restoreMeta } from "./restore-meta";
import { restoreTask } from "./restore-task";

export const ROLLBACK_ACTION = "card.rollback";

// R-023, AC-009: one action undoes one edit. People only: an agent could use
// it to step around the guard (a closing status, someone else's text), and the
// leaked-key case needs a person anyway. Both outcomes are journaled.
export async function rollbackCard(input: {
  workspaceId: string;
  taskId: string;
  historyId: string;
  actor: ForestActor;
  headers: AgentHeaders;
}) {
  const { workspaceId, taskId, actor } = input;
  const entry = await loadHistoryEntry(taskId, input.historyId);
  const journal = (outcome: "allowed" | "denied", detail: string) =>
    writeJournal({
      workspaceId,
      actor,
      action: ROLLBACK_ACTION,
      targetType: "task",
      targetId: taskId,
      outcome,
      detail,
    });

  try {
    if (actor.kind === "agent") {
      throw new ForestError(
        "agent_forbidden",
        "a rollback is a person's action; ask the owner",
      );
    }
    const restore = { taskId, workspaceId, changes: entry.changes, actor };
    // An agent's move to a work stage filled the assignee and start date in
    // its own row; one rollback undoes both (AC-009, TB-69).
    const autofill = await loadAutofillOf(entry);
    const result =
      entry.kind === "task"
        ? {
            kind: entry.kind,
            revision: (
              await restoreTask({ ...restore, autofill: autofill?.changes })
            ).revision,
            meta: null,
          }
        : {
            kind: entry.kind,
            revision: null,
            meta: await restoreMeta({ ...restore, headers: input.headers }),
          };
    await journal(
      "allowed",
      `history ${entry.id}: ${Object.keys(entry.changes).join(",")}${autofill ? `; autofill ${autofill.id}` : ""}`,
    );
    return result;
  } catch (error) {
    if (error instanceof ForestError) await journal("denied", error.message);
    throw error;
  }
}
