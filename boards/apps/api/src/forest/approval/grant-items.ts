import type { GrantApprovalAction } from "./approval-params";

export function splitIds(joined: string | undefined): string[] {
  return (joined ?? "").split(",").filter(Boolean);
}

// What the hash of a grant binds (R-10). The hash sorts its items, so each
// part carries a prefix: «name:x» and «task:x» never collide.
export function grantItems(
  action: GrantApprovalAction,
  params: Record<string, string>,
): string[] {
  const tasks = splitIds(params.taskIds).map((id) => `task:${id}`);
  if (action === "create_label") {
    return [
      `name:${params.name ?? ""}`,
      `color:${params.color ?? ""}`,
      ...tasks,
    ];
  }
  if (action === "attach_label") return tasks;
  return [`user:${params.userId ?? ""}`];
}
