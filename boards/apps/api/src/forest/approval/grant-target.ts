import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, userTable } from "../../database/schema";
import { assertAssignableUser } from "../../utils/assert-assignable-user";
import { assertTaskInWorkspace } from "../task-scope";
import type { GrantApprovalAction } from "./approval-params";
import { grantItems } from "./grant-items";

export type GrantRequest = {
  targetId: string;
  value?: string;
  label?: { name: string; color: string };
  taskIds?: string[];
};

async function assertTasks(
  workspaceId: string,
  userId: string,
  taskIds: string[] | undefined,
): Promise<string[]> {
  const ids = [...new Set(taskIds ?? [])];
  if (ids.length === 0) {
    throw new HTTPException(400, { message: "taskIds: name the cards" });
  }
  for (const id of ids) await assertTaskInWorkspace(id, workspaceId, userId);
  return ids;
}

// TB-102 R-10: the request fixes exactly what the server will do on «да»;
// the same parts go into the hash (grantItems).
export async function grantApprovalTarget(
  workspaceId: string,
  userId: string,
  action: GrantApprovalAction,
  body: GrantRequest,
): Promise<{
  targetType: "workspace" | "label" | "task";
  items: string[];
  params: Record<string, string>;
}> {
  if (action === "create_label") {
    if (body.targetId !== workspaceId) {
      throw new HTTPException(400, {
        message: "create_label: targetId is the workspace id",
      });
    }
    if (!body.label) {
      throw new HTTPException(400, { message: "create_label needs label" });
    }
    const ids = await assertTasks(workspaceId, userId, body.taskIds);
    const params = { ...body.label, taskIds: ids.join(",") };
    return {
      targetType: "workspace",
      items: grantItems(action, params),
      params,
    };
  }

  if (action === "attach_label") {
    const label = await db.query.labelTable.findFirst({
      where: eq(labelTable.id, body.targetId),
    });
    if (!label || label.workspaceId !== workspaceId || label.taskId !== null) {
      throw new HTTPException(404, {
        message: "attach_label: targetId is a workspace label id",
      });
    }
    if (label.deletionStartedAt) {
      throw new HTTPException(409, { message: "This label is being deleted" });
    }
    const ids = await assertTasks(workspaceId, userId, body.taskIds);
    const params = { labelName: label.name, taskIds: ids.join(",") };
    return { targetType: "label", items: grantItems(action, params), params };
  }

  if (!body.value) {
    throw new HTTPException(400, {
      message: "set_assignee needs value: the user id",
    });
  }
  const task = await assertTaskInWorkspace(body.targetId, workspaceId, userId);
  await assertAssignableUser(body.value, workspaceId, task.projectId);
  const [user] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, body.value))
    .limit(1);
  const params = { userId: body.value, userName: user?.name ?? body.value };
  return { targetType: "task", items: grantItems(action, params), params };
}
