import { HTTPException } from "hono/http-exception";
import { VALID_PRIORITIES } from "../../task/validate-task-fields";
import { isClosingStatus } from "../agent-guard/closing-status";
import { assertTaskInWorkspace } from "../task-scope";
import type { TaskApprovalAction } from "./approval-params";

// The value is part of what the owner approves: an approval to close into
// «done» does not cover «archived», and one for «high» does not cover «urgent».
export async function taskApprovalTarget(
  workspaceId: string,
  userId: string,
  action: TaskApprovalAction,
  taskId: string,
  value: string | undefined,
): Promise<{ items: string[]; params: Record<string, string> }> {
  if (!value) {
    throw new HTTPException(400, {
      message: `${action} needs a value: the target status or the new priority`,
    });
  }
  const task = await assertTaskInWorkspace(taskId, workspaceId, userId);
  // «Брёвна» are terminal (R-8): no request can move a card out of them, so
  // the owner never gets one that is sure to fail.
  if (task.status === "closed") {
    throw new HTTPException(400, {
      message: `the card is in «Брёвна» (closed): ${action} cannot change it`,
    });
  }
  if (action === "close_task") {
    if (!(await isClosingStatus(task.projectId, value))) {
      throw new HTTPException(400, {
        message: `"${value}" does not close a card in this project; agents move open statuses without approval`,
      });
    }
    return { items: [value], params: { status: value } };
  }
  if (action === "reopen_task") {
    if (!(await isClosingStatus(task.projectId, task.status))) {
      throw new HTTPException(400, {
        message: "the card is open; reopen_task is for closed cards",
      });
    }
    if (await isClosingStatus(task.projectId, value)) {
      throw new HTTPException(400, {
        message: `"${value}" keeps the card closed; name an open status`,
      });
    }
    return { items: [value], params: { status: value } };
  }
  if (!(VALID_PRIORITIES as readonly string[]).includes(value)) {
    throw new HTTPException(400, {
      message: `Invalid priority "${value}". Valid values: ${VALID_PRIORITIES.join(", ")}`,
    });
  }
  return { items: [value], params: { priority: value } };
}
