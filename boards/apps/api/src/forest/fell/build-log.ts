import type { TreeMaterial } from "./tree-material";

export const LOG_HISTORY_LIMIT = 500;
const HISTORY_CONTENT_CHARS = 4000;
export const SEARCH_TEXT_CHARS = 100_000;

export type LogDraft = {
  sourceTaskId: string;
  sourceProjectId: string;
  sourceProjectName: string;
  taskNumber: number | null;
  title: string;
  finalStatus: string;
  priority: string;
  description: string | null;
  fields: Record<string, unknown>;
  history: Record<string, unknown>[];
  felledTaskIds: string[];
  searchText: string;
};

// The log keeps the root's fields and history as they were (R-028); the
// branches below it go to seeds. Nothing here can be appended to later.
export function buildLog(material: TreeMaterial): LogDraft {
  const { root } = material;
  const rootActivities = material.activities
    .filter((activity) => activity.taskId === root.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const kept = rootActivities.slice(-LOG_HISTORY_LIMIT);

  const history = kept.map((activity) => ({
    type: activity.type,
    content: activity.content?.slice(0, HISTORY_CONTENT_CHARS) ?? null,
    userId: activity.userId,
    createdAt: activity.createdAt.toISOString(),
    eventData: activity.eventData ?? null,
  }));

  const fields = {
    id: root.id,
    number: root.number,
    status: root.status,
    priority: root.priority,
    assigneeId: root.userId,
    columnId: root.columnId,
    startDate: root.startDate?.toISOString() ?? null,
    dueDate: root.dueDate?.toISOString() ?? null,
    createdAt: root.createdAt.toISOString(),
    updatedAt: root.updatedAt.toISOString(),
    revision: root.revision,
    labels: material.labels
      .filter((label) => label.taskId === root.id)
      .map((label) => label.name),
    assets: material.assets
      .filter((asset) => asset.taskId === root.id)
      .map((asset) => asset.name),
    branchCount: material.tasks.length - 1,
    historyDropped: rootActivities.length - kept.length,
  };

  const searchText = [
    root.title,
    root.description ?? "",
    ...kept.map((activity) => activity.content ?? ""),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, SEARCH_TEXT_CHARS);

  return {
    sourceTaskId: root.id,
    sourceProjectId: root.projectId,
    sourceProjectName: material.projectName,
    taskNumber: root.number,
    title: root.title,
    finalStatus: root.status,
    priority: root.priority,
    description: root.description,
    fields,
    history,
    felledTaskIds: material.tasks.map((task) => task.id),
    searchText,
  };
}
