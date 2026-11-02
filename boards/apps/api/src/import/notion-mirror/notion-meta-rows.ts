import type { ImportedTask } from "@kaneo/importers";
import { type NotionCardMeta, notionCardMeta } from "./notion-card-meta";

export function notionMetaRows(
  tasks: readonly ImportedTask[],
  taskIds: ReadonlyMap<string, string>,
  // Keys of pages whose Backlog ID another card holds.
  backlogDropped: ReadonlySet<string> = new Set(),
): Array<{ taskId: string; meta: NotionCardMeta }> {
  return tasks.flatMap((task) => {
    const taskId = taskIds.get(task.key);
    const meta = notionCardMeta(task, !backlogDropped.has(task.key));
    return taskId && meta ? [{ taskId, meta }] : [];
  });
}
