// R-034: what a session of each role sees in tools/list. The role trims the
// list to save tokens; it is not an authorization check — the API still
// decides what the caller may do with every tool it reaches.
const READ = [
  "whoami",
  "list_workspaces",
  "list_projects",
  "get_project",
  "list_tasks",
  "get_task",
  "get_task_by_ticket_id",
  "search",
  "list_task_comments",
  "forest_get_card_meta",
  "forest_get_card_memory",
  "forest_list_work_state",
  "notebook_search",
] as const;

// Owner decision 13.11: research, ideation and spec work go through the
// notebook (thread in «Вопросы», brief for a spec, pages used in «Источники»).
// Asks and briefs spend the shared daily model cap and every tool writes, so
// the read-only reader role does not get them.
const NOTEBOOK = [
  "notebook_ask",
  "notebook_brief",
  "notebook_add_source",
] as const;

// A working session takes leases and keeps its state on the board (R-037).
const LEASE = [
  "forest_acquire_lease",
  "forest_release_lease",
  "forest_set_work_state",
  "forest_clear_work_state",
] as const;

export const ROLE_TOOLS = {
  reader: [...READ],
  developer: [
    ...READ,
    ...NOTEBOOK,
    ...LEASE,
    "update_task",
    "update_task_status",
    "create_task_comment",
    "get_task_relations",
    "list_project_columns",
    "forest_set_card_meta",
    "forest_request_approval",
  ],
  reviewer: [
    ...READ,
    ...NOTEBOOK,
    ...LEASE,
    "update_task_status",
    "create_task_comment",
    "get_task_relations",
    "list_task_activity",
    "forest_request_approval",
  ],
  planner: [
    ...READ,
    ...NOTEBOOK,
    ...LEASE,
    "create_task",
    "update_task",
    "move_task",
    "update_task_status",
    "update_task_assignee",
    "update_task_due_date",
    "create_task_comment",
    "create_task_relation",
    "get_task_relations",
    "list_project_columns",
    "list_workspace_members",
    "list_workspace_labels",
    "attach_label_to_task",
    "forest_set_card_meta",
    "forest_request_approval",
    "forest_list_approvals",
    "forest_list_sectors",
  ],
  forester: [
    ...READ,
    ...LEASE,
    "forest_request_approval",
    "forest_list_approvals",
    "forest_list_sectors",
    "forest_detect_sectors",
    "forest_fell",
    "forest_grow",
    "forest_list_logs",
    "forest_get_log",
  ],
} as const satisfies Record<string, readonly string[]>;

export type McpRole = keyof typeof ROLE_TOOLS;

// A client names its role in this header. Without it the session keeps the
// full kaneo set, so plain kaneo MCP clients work as before.
export const ROLE_HEADER = "x-t-boards-role";

// Tools a session may take beyond its role, over its whole life.
export const EXTRA_TOOLS_MAX = 5;

export const MCP_ROLES = Object.keys(ROLE_TOOLS) as McpRole[];

export function isMcpRole(value: string): value is McpRole {
  return Object.hasOwn(ROLE_TOOLS, value);
}
