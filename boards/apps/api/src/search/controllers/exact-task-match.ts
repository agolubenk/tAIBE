import { and, eq, ilike, inArray, type SQL } from "drizzle-orm";
import db from "../../database";
import { cardMetaTable } from "../../database/forest-schema";
import {
  projectTable,
  taskTable,
  userTable,
  workspaceTable,
} from "../../database/schema";
import { escapeLikePattern } from "../like-pattern";
import { notionPageIdOf } from "../notion-page-id";
import type { SearchResult } from "../search-result";
import { TASK_SHORT_ID_PATTERN } from "../task-short-id";

const MAX_TASK_NUMBER = 2_147_483_647;

// The card the query names exactly: its Notion page id or link (TB-91), or
// its short id «DEP-23». The id beats the key, so a Notion id whose last
// group is all digits is not read as a key.
function exactTaskCondition(query: string): SQL | undefined {
  const notionPageId = notionPageIdOf(query);
  if (notionPageId) {
    return inArray(
      taskTable.id,
      db
        .select({ taskId: cardMetaTable.taskId })
        .from(cardMetaTable)
        .where(eq(cardMetaTable.notionPageId, notionPageId)),
    );
  }
  // `generateProjectSlug` normalizes to NFKC before it stores a key, so the
  // query is normalized too, or a decomposed "ПА-23" would never reach the
  // stored composed form.
  const shortId = query.normalize("NFKC").match(TASK_SHORT_ID_PATTERN);
  const taskNumber = Number(shortId?.[2]);
  if (
    !shortId?.[1] ||
    !Number.isSafeInteger(taskNumber) ||
    taskNumber <= 0 ||
    taskNumber > MAX_TASK_NUMBER
  ) {
    return undefined;
  }
  return and(
    // A project key may hold `_`, which `ilike` reads as "any one
    // character", so `DE_-23` would also match a task in `DEP` and the
    // `limit(1)` below would pick whichever came back first. Escaping keeps
    // the case-insensitive comparison and drops the wildcards.
    ilike(projectTable.slug, escapeLikePattern(shortId[1])),
    eq(taskTable.number, taskNumber),
  );
}

export async function exactTaskMatches({
  query,
  workspaceFilter,
  projectId,
}: {
  query: string;
  workspaceFilter: SQL | undefined;
  projectId?: string;
}): Promise<SearchResult[]> {
  const exact = exactTaskCondition(query);
  if (!exact) return [];

  const tasks = await db
    .select({
      id: taskTable.id,
      title: taskTable.title,
      description: taskTable.description,
      projectId: taskTable.projectId,
      projectName: projectTable.name,
      projectSlug: projectTable.slug,
      workspaceId: projectTable.workspaceId,
      workspaceName: workspaceTable.name,
      userId: taskTable.userId,
      userName: userTable.name,
      createdAt: taskTable.createdAt,
      taskNumber: taskTable.number,
      priority: taskTable.priority,
      status: taskTable.status,
    })
    .from(taskTable)
    .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(
      and(
        workspaceFilter,
        projectId ? eq(taskTable.projectId, projectId) : undefined,
        exact,
      ),
    )
    .limit(1);

  return tasks.map((task) => ({
    id: task.id,
    type: "task",
    title: task.title,
    description: task.description || undefined,
    projectId: task.projectId,
    projectName: task.projectName || undefined,
    projectSlug: task.projectSlug || undefined,
    workspaceId: task.workspaceId || undefined,
    workspaceName: task.workspaceName || undefined,
    userId: task.userId || undefined,
    userName: task.userName || undefined,
    createdAt: task.createdAt,
    relevanceScore: 10, // Highest relevance for an exact match
    taskNumber: task.taskNumber || undefined,
    priority: task.priority || undefined,
    status: task.status,
  }));
}
