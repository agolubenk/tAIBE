import { restoreRedacted } from "@kaneo/redact/restore";
import type { TaskChanges } from "./classify-task-request";
import type { CurrentTask } from "./decide-task-write";

function restore(incoming: string, stored: string | null): string {
  const result = restoreRedacted(stored ?? "", incoming);
  // A count mismatch stays a change here; the route answers it with 409.
  return result.ok ? result.text : incoming;
}

// TB-143: an agent reads the card text masked. N-004 compares what the write
// would store, so a masked title or description sent back unchanged is not
// an edit of the owner's text.
export function restoreGuardedText(
  changes: TaskChanges,
  task: CurrentTask,
): TaskChanges {
  const restored = { ...changes };
  if (typeof changes.title === "string") {
    restored.title = restore(changes.title, task.title);
  }
  if (typeof changes.description === "string") {
    restored.description = restore(changes.description, task.description);
  }
  return restored;
}
