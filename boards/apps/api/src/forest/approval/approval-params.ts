import { createHash } from "node:crypto";

export const APPROVAL_ACTIONS = [
  "fell_tree",
  "fell_sector",
  "close_task",
  "reopen_task",
  "set_priority",
  "create_label",
  "attach_label",
  "set_assignee",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

// Task actions an agent needs the owner's «да» for (R-022); felling has its
// own route and needs task:delete.
export const TASK_APPROVAL_ACTIONS = [
  "close_task",
  "reopen_task",
  "set_priority",
] as const;
export type TaskApprovalAction = (typeof TASK_APPROVAL_ACTIONS)[number];

// One-time rights the server itself carries out on «да» (TB-102 R-10); the
// agent never gets the right.
export const GRANT_APPROVAL_ACTIONS = [
  "create_label",
  "attach_label",
  "set_assignee",
] as const;
export type GrantApprovalAction = (typeof GRANT_APPROVAL_ACTIONS)[number];

export type FellAction = Exclude<
  ApprovalAction,
  TaskApprovalAction | GrantApprovalAction
>;

export function isTaskApprovalAction(
  action: ApprovalAction,
): action is TaskApprovalAction {
  return (TASK_APPROVAL_ACTIONS as readonly string[]).includes(action);
}

export function isGrantApprovalAction(
  action: ApprovalAction,
): action is GrantApprovalAction {
  return (GRANT_APPROVAL_ACTIONS as readonly string[]).includes(action);
}

export const APPROVAL_TTL_HOURS = 24;

// pending → consumed | rejected | failed | expired. «approved» is kept only
// for rows decided before the server applied «да» itself (R-11 migrates them).
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "consumed",
  "failed",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// R-9: a closing request names its done-log entry or why there is none.
export const DONE_REASONS = ["duplicate", "obsolete", "import"] as const;
export type DoneReason = (typeof DONE_REASONS)[number];
export const DONE_REF_PATTERN =
  /^https:\/\/github\.com\/agolubenk\/(HR_Helper-v2|tAIBE)\/(commit\/[0-9a-f]{7,40}|pull\/\d+)$/;

// An approval covers exactly what the owner saw: for a felling the sorted
// tree ids, for a task action the one value (closing or reopening status, new
// priority), for a grant its prefixed parts (name:, color:, task:, user:).
// A changed sector, tree list or value needs a fresh «да».
export function approvalParamsHash(
  action: ApprovalAction,
  targetId: string,
  items: readonly string[],
): string {
  const canonical = JSON.stringify({
    action,
    targetId,
    // Key kept from the felling-only version so stored hashes still match.
    treeIds: [...new Set(items)].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
