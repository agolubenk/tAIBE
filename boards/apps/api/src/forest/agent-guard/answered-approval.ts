import { and, eq } from "drizzle-orm";
import db from "../../database";
import { ownerApprovalTable } from "../../database/forest-schema";
import {
  approvalParamsHash,
  type TaskApprovalAction,
} from "../approval/approval-params";
import { ForestError } from "../forest-error";

export type AnsweredApproval =
  | { kind: "applied"; approvalId: string; appliedAt: Date | null }
  | { kind: "refused"; error: ForestError };

// TB-102 R-5: the server applies the owner's «да» itself, so an approvalId
// on a task write gives no right any more (kept for one release). It only
// tells the agent what became of its request; the write never runs.
export async function answeredApproval(input: {
  approvalId: string;
  workspaceId: string;
  action: TaskApprovalAction;
  taskId: string;
  value: string;
}): Promise<AnsweredApproval> {
  const row = await db.query.ownerApprovalTable.findFirst({
    where: and(
      eq(ownerApprovalTable.id, input.approvalId),
      eq(ownerApprovalTable.workspaceId, input.workspaceId),
    ),
  });
  if (!row) {
    return {
      kind: "refused",
      error: new ForestError(
        "approval_required",
        "no such approval in this workspace",
      ),
    };
  }
  const hash = approvalParamsHash(input.action, input.taskId, [input.value]);
  if (
    row.action !== input.action ||
    row.targetId !== input.taskId ||
    row.paramsHash !== hash
  ) {
    return {
      kind: "refused",
      error: new ForestError(
        "approval_mismatch",
        `approval ${row.id} covers ${row.action} ${JSON.stringify(row.params ?? {})}, not this write`,
      ),
    };
  }
  if (row.status === "consumed") {
    return { kind: "applied", approvalId: row.id, appliedAt: row.consumedAt };
  }
  if (row.status === "approved") {
    return {
      kind: "refused",
      error: new ForestError(
        "approval_pending",
        "a «да» from before TB-102: the server applies it in the R-11 migration; do not retry",
      ),
    };
  }
  if (row.status === "pending") {
    return {
      kind: "refused",
      error: new ForestError(
        "approval_pending",
        "waits for the owner's answer; the server applies «да» itself, do not retry",
      ),
    };
  }
  return {
    kind: "refused",
    error: new ForestError(
      "approval_closed",
      `approval ${row.id} is ${row.status}${row.failReason ? ` (${row.failReason})` : ""}`,
    ),
  };
}
