import type { QueueDoc, QueueEvent } from "./queue-client";

export type QueueAnswer =
  | { kind: "none" }
  // «done» without a choice: a tick on /queue, not a decision (R-2).
  | { kind: "undecided" }
  | {
      kind: "yes" | "no";
      answeredAt: Date;
      answeredBy: string;
      note?: string;
    };

// R-2, R-3: the owner's fields of checks/<id>. The time and the author come
// from the queue journal — the newest run of events in which «choice» holds
// its current value starts at the write that set it. The browser's «at» is
// never used (F20). The journal keeps 50 events: a longer run takes its
// oldest event, a later time, so an answer is never read as earlier.
export function readAnswer(
  check: QueueDoc | null,
  events: QueueEvent[],
): QueueAnswer {
  const choice = check?.data.choice;
  const done = check?.data.done === true;
  if (choice !== "yes" && choice !== "no") {
    return done || (typeof choice === "string" && choice !== "")
      ? { kind: "undecided" }
      : { kind: "none" };
  }
  let setter: QueueEvent | null = null;
  for (const event of events) {
    if (event.after?.choice !== choice) break;
    setter = event;
  }
  const note =
    typeof check?.data.note === "string" && check.data.note
      ? check.data.note
      : undefined;
  if (!setter) {
    // A choice with no journal row for it: wait for the journal to show it.
    return { kind: "none" };
  }
  return {
    kind: choice,
    answeredAt: new Date(setter.at),
    answeredBy: setter.actor,
    note,
  };
}

// R-4 second check: the newest write of the item is t-boards' own.
export function lastWriter(events: QueueEvent[]): string | null {
  return events[0]?.actor ?? null;
}
