import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db from "../../database";
import {
  activityTable,
  projectTable,
  taskTable,
  userTable,
  workspaceTable,
  workspaceUserTable,
} from "../../database/schema";
import { canAccessProject } from "../../project-access/can-access-project";
import { projectAccessCondition } from "../../project-access/project-access-condition";
import { isMarkerQuery } from "../../utils/visible-match";
import { TASK_SHORT_ID_PATTERN } from "../task-short-id";
import { getActivitySearchContent } from "./activity-content";
import { findTaskByShortId } from "./short-id-task";
import { searchWindow } from "./visible-rows";

type SearchParams = {
  query: string;
  userEmail?: string;
  userId?: string;
  type?:
    | "all"
    | "tasks"
    | "projects"
    | "workspaces"
    | "comments"
    | "activities";
  workspaceId?: string;
  projectId?: string;
  limit?: number;
  /** A caller with a token reads masked text: matches count only in it (TB-191). */
  tokenCaller?: boolean;
};

type SearchResult = {
  id: string;
  type: "task" | "project" | "workspace" | "comment" | "activity";
  title: string;
  description?: string;
  content?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  userName?: string;
  createdAt: Date;
  relevanceScore: number;
  taskNumber?: number;
  projectSlug?: string;
  priority?: string;
  status?: string;
};

async function globalSearch(params: SearchParams): Promise<{
  results: SearchResult[];
  totalCount: number;
  searchQuery: string;
}> {
  const {
    query,
    userId,
    userEmail,
    type = "all",
    workspaceId,
    projectId,
    limit = 20,
    tokenCaller = false,
  } = params;

  if (tokenCaller && isMarkerQuery(query)) {
    return { results: [], totalCount: 0, searchQuery: query };
  }
  // TB-191: a caller with a token gets the newest candidates, scored again
  // on the text it reads; the owner keeps the SQL ranking.
  const { rows, order, budget, pick } = searchWindow(tokenCaller, query, limit);

  let resolvedUserId = userId;
  if (!resolvedUserId && userEmail) {
    const user = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, userEmail))
      .limit(1);

    if (user.length > 0 && user[0]) {
      resolvedUserId = user[0].id;
    }
  }

  if (!resolvedUserId) {
    return { results: [], totalCount: 0, searchQuery: query };
  }

  const userWorkspaces = await db
    .select({ workspaceId: workspaceUserTable.workspaceId })
    .from(workspaceUserTable)
    .where(eq(workspaceUserTable.userId, resolvedUserId));

  const accessibleWorkspaceIds = userWorkspaces
    .map((w) => w.workspaceId)
    .filter(Boolean);

  if (
    accessibleWorkspaceIds.length === 0 ||
    (projectId && !(await canAccessProject(resolvedUserId, projectId)))
  ) {
    return { results: [], totalCount: 0, searchQuery: query };
  }

  const results: SearchResult[] = [];
  const searchPattern = `%${query.toLowerCase()}%`;

  const workspaceFilter = and(
    workspaceId
      ? eq(projectTable.workspaceId, workspaceId)
      : inArray(projectTable.workspaceId, accessibleWorkspaceIds),
    projectAccessCondition(resolvedUserId, projectTable.id),
  );

  // Check if query matches short-id pattern (e.g. "DEP-23"). `generateProjectSlug`
  // normalizes to NFKC before it stores a key, so the query is normalized too,
  // or a decomposed "ПА-23" would never reach the stored composed form.
  const shortIdMatch = query.normalize("NFKC").match(TASK_SHORT_ID_PATTERN);

  const shortIdNumber = Number(shortIdMatch?.[2]);

  if (type === "all" || type === "tasks") {
    const seenTaskIds = new Set<string>();

    // If query matches short-id pattern, look up by project slug + task number first
    if (
      shortIdMatch?.[1] &&
      Number.isSafeInteger(shortIdNumber) &&
      shortIdNumber > 0 &&
      shortIdNumber <= 2_147_483_647
    ) {
      const slug = shortIdMatch[1];
      const taskNumber = shortIdNumber;

      const shortIdTasks = await findTaskByShortId(
        slug,
        taskNumber,
        workspaceFilter,
        projectId,
      );

      for (const task of shortIdTasks) {
        seenTaskIds.add(task.id);
        results.push({
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
          relevanceScore: 10, // Highest relevance for exact short-id match
          taskNumber: task.taskNumber || undefined,
          priority: task.priority || undefined,
          status: task.status,
        });
      }
    }

    // Also run text search for tasks
    const taskRelevanceScore = sql<number>`
      CASE
        WHEN LOWER(${taskTable.title}) LIKE ${searchPattern} THEN 3
        WHEN LOWER(${taskTable.description}) LIKE ${searchPattern} THEN 2
        ELSE 1
      END
    `;

    const tasksFit = budget(taskTable.createdAt, [
      taskTable.title,
      taskTable.description,
    ]);
    const taskQuery = db
      .select({
        id: taskTable.id,
        title: taskTable.title,
        description: tasksFit.text<string>(taskTable.description),
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
        relevanceScore: taskRelevanceScore.as("relevanceScore"),
        fits: tasksFit.fits,
      })
      .from(taskTable)
      .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .leftJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
      .leftJoin(userTable, eq(taskTable.userId, userTable.id))
      .where(
        and(
          workspaceFilter,
          projectId ? eq(taskTable.projectId, projectId) : undefined,
          or(
            ilike(taskTable.title, searchPattern),
            ilike(taskTable.description, searchPattern),
          ),
        ),
      )
      .orderBy(...order(taskRelevanceScore, taskTable.createdAt))
      .limit(rows);

    const tasks = await taskQuery;

    for (const task of pick(tasks, (t) => [
      [t.title, 3],
      [t.description, 2],
    ])) {
      if (seenTaskIds.has(task.id)) continue;
      results.push({
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
        relevanceScore: task.relevanceScore,
        taskNumber: task.taskNumber || undefined,
        priority: task.priority || undefined,
        status: task.status,
      });
    }
  }

  if (type === "all" || type === "projects") {
    const projectRelevanceScore = sql<number>`
      CASE
        WHEN LOWER(${projectTable.name}) LIKE ${searchPattern} THEN 3
        WHEN LOWER(${projectTable.description}) LIKE ${searchPattern} THEN 2
        ELSE 1
      END
    `;

    const projectsFit = budget(projectTable.createdAt, [
      projectTable.name,
      projectTable.description,
    ]);
    const projectQuery = db
      .select({
        id: projectTable.id,
        name: projectTable.name,
        description: projectsFit.text<string>(projectTable.description),
        slug: projectTable.slug,
        workspaceId: projectTable.workspaceId,
        workspaceName: workspaceTable.name,
        createdAt: projectTable.createdAt,
        relevanceScore: projectRelevanceScore.as("relevanceScore"),
        fits: projectsFit.fits,
      })
      .from(projectTable)
      .leftJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
      .where(
        and(
          workspaceFilter,
          or(
            ilike(projectTable.name, searchPattern),
            ilike(projectTable.description, searchPattern),
          ),
        ),
      )
      .orderBy(...order(projectRelevanceScore, projectTable.createdAt))
      .limit(rows);

    const projects = await projectQuery;

    for (const project of pick(projects, (p) => [
      [p.name, 3],
      [p.description, 2],
    ])) {
      results.push({
        id: project.id,
        type: "project",
        title: project.name,
        description: project.description || undefined,
        projectId: project.id,
        projectSlug: project.slug || undefined,
        workspaceId: project.workspaceId,
        workspaceName: project.workspaceName || undefined,
        createdAt: project.createdAt,
        relevanceScore: project.relevanceScore,
      });
    }
  }

  if (type === "all" || type === "workspaces") {
    const workspaceRelevanceScore = sql<number>`
      CASE
        WHEN LOWER(${workspaceTable.name}) LIKE ${searchPattern} THEN 3
        WHEN LOWER(${workspaceTable.description}) LIKE ${searchPattern} THEN 2
        ELSE 1
      END
    `;

    const workspacesFit = budget(workspaceTable.createdAt, [
      workspaceTable.name,
      workspaceTable.description,
    ]);
    const workspaceQuery = db
      .select({
        id: workspaceTable.id,
        name: workspaceTable.name,
        description: workspacesFit.text<string>(workspaceTable.description),
        createdAt: workspaceTable.createdAt,
        relevanceScore: workspaceRelevanceScore.as("relevanceScore"),
        fits: workspacesFit.fits,
      })
      .from(workspaceTable)
      .leftJoin(
        workspaceUserTable,
        eq(workspaceTable.id, workspaceUserTable.workspaceId),
      )
      .where(
        and(
          inArray(workspaceTable.id, accessibleWorkspaceIds),
          or(
            ilike(workspaceTable.name, searchPattern),
            ilike(workspaceTable.description, searchPattern),
          ),
        ),
      )
      .orderBy(...order(workspaceRelevanceScore, workspaceTable.createdAt))
      .limit(rows);

    const workspaces = await workspaceQuery;

    for (const workspace of pick(workspaces, (w) => [
      [w.name, 3],
      [w.description, 2],
    ])) {
      results.push({
        id: workspace.id,
        type: "workspace",
        title: workspace.name,
        description: workspace.description || undefined,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        createdAt: workspace.createdAt,
        relevanceScore: workspace.relevanceScore,
      });
    }
  }

  if (type === "all" || type === "comments" || type === "activities") {
    const searchableActivityText = sql<string>`COALESCE(${activityTable.content}, CAST(${activityTable.eventData} AS text), '')`;
    const activityRelevanceScore = sql<number>`
      CASE
        WHEN LOWER(${searchableActivityText}) LIKE ${searchPattern} THEN 2
        WHEN LOWER(${taskTable.title}) LIKE ${searchPattern} THEN 1
        ELSE 1
      END
    `;

    const activitiesFit = budget(activityTable.createdAt, [
      searchableActivityText,
      taskTable.title,
    ]);
    const activityQuery = db
      .select({
        id: activityTable.id,
        type: activityTable.type,
        content: activitiesFit.text<string>(activityTable.content),
        eventData: activitiesFit.text<unknown>(activityTable.eventData),
        taskId: activityTable.taskId,
        taskTitle: taskTable.title,
        taskNumber: taskTable.number,
        projectId: projectTable.id,
        projectName: projectTable.name,
        projectSlug: projectTable.slug,
        workspaceId: projectTable.workspaceId,
        workspaceName: workspaceTable.name,
        userId: activityTable.userId,
        userName: userTable.name,
        createdAt: activityTable.createdAt,
        searchText: activitiesFit.text<string>(searchableActivityText),
        relevanceScore: activityRelevanceScore.as("relevanceScore"),
        fits: activitiesFit.fits,
      })
      .from(activityTable)
      .leftJoin(taskTable, eq(activityTable.taskId, taskTable.id))
      .leftJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .leftJoin(workspaceTable, eq(projectTable.workspaceId, workspaceTable.id))
      .leftJoin(userTable, eq(activityTable.userId, userTable.id))
      .where(
        and(
          workspaceFilter,
          projectId ? eq(taskTable.projectId, projectId) : undefined,
          or(
            ilike(searchableActivityText, searchPattern),
            ilike(taskTable.title, searchPattern),
          ),
          type === "comments" ? eq(activityTable.type, "comment") : undefined,
        ),
      )
      .orderBy(...order(activityRelevanceScore, activityTable.createdAt))
      .limit(rows);

    const activities = await activityQuery;

    for (const activity of pick(activities, (a) => [
      [a.searchText, 2],
      [a.taskTitle, 1],
    ])) {
      const isComment = activity.type === "comment";
      const activityContent = getActivitySearchContent(
        activity.type,
        activity.content,
        activity.eventData,
      );
      results.push({
        id: activity.id,
        type: isComment ? "comment" : "activity",
        title: isComment
          ? `Comment on ${activity.taskTitle || "task"}`
          : `${activity.type} on ${activity.taskTitle || "task"}`,
        content: activityContent,
        projectId: activity.projectId || undefined,
        projectName: activity.projectName || undefined,
        projectSlug: activity.projectSlug || undefined,
        workspaceId: activity.workspaceId || undefined,
        workspaceName: activity.workspaceName || undefined,
        userId: activity.userId || undefined,
        userName: activity.userName || undefined,
        createdAt: activity.createdAt,
        relevanceScore: activity.relevanceScore,
        taskNumber: activity.taskNumber || undefined,
      });
    }
  }

  results.sort((a, b) => {
    if (a.relevanceScore !== b.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const finalResults = results.slice(0, limit);

  return {
    results: finalResults,
    totalCount: results.length,
    searchQuery: query,
  };
}

export default globalSearch;
