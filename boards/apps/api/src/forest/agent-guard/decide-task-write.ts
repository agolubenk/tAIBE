import type { TaskApprovalAction } from "../approval/approval-params";
import type { TaskChanges } from "./classify-task-request";

export type CurrentTask = {
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

export type WriteFacts = {
  // The status the card would land in closes it (final column, archived).
  closes: boolean;
  // The card is closed now and the new status opens it again.
  reopens: boolean;
  // An agent created this card, so its text is not the owner's statement.
  authoredByAgent: boolean;
  // A move to another project: the status the card lands in (TB-80). Its
  // closes and reopens compare the two projects, so they count even when the
  // slug stays the same or the request names no status.
  landing?: string;
};

export type WriteDecision =
  | { kind: "deny"; reason: string }
  | {
      kind: "allow";
      approval: { action: TaskApprovalAction; value: string } | null;
    };

// R-022 and N-004 for one agent edit: the owner's text stays the owner's,
// closing, reopening and reprioritising wait for the owner's «да», the
// rest goes.
export function changesText(changes: TaskChanges, current: CurrentTask) {
  return (
    (changes.title !== undefined && changes.title !== current.title) ||
    (changes.description !== undefined &&
      (changes.description ?? "") !== (current.description ?? ""))
  );
}

export function decideTaskWrite(
  changes: TaskChanges,
  current: CurrentTask,
  facts: WriteFacts,
): WriteDecision {
  if (changesText(changes, current) && !facts.authoredByAgent) {
    return {
      kind: "deny",
      reason:
        "the card text is the owner's statement (N-004); add a comment instead",
    };
  }

  // «Брёвна» are terminal (R-8): no «да» takes a card out of them, so a move
  // of such a card is refused here, not sent to the owner.
  if (facts.landing !== undefined && current.status === "closed") {
    return {
      kind: "deny",
      reason:
        "the card is in «Брёвна» (closed), which is terminal (R-8): it does not move to another project",
    };
  }

  const statusChanged =
    facts.landing !== undefined ||
    (changes.status !== undefined && changes.status !== current.status);
  const status = facts.landing ?? changes.status;
  const statusAction = !statusChanged
    ? null
    : facts.closes
      ? "close_task"
      : facts.reopens
        ? "reopen_task"
        : null;
  const priorityChanged =
    changes.priority !== undefined && changes.priority !== current.priority;
  if (statusAction && priorityChanged) {
    return {
      kind: "deny",
      reason: `${statusAction === "close_task" ? "closing" : "reopening"} and a priority change need separate approvals; send them one at a time`,
    };
  }
  if (statusAction && status) {
    return {
      kind: "allow",
      approval: { action: statusAction, value: status },
    };
  }
  if (priorityChanged && changes.priority) {
    return {
      kind: "allow",
      approval: { action: "set_priority", value: changes.priority },
    };
  }
  return { kind: "allow", approval: null };
}
