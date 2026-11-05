// t-boards forest model (spec R-026, R-028, R-029, N-011; architecture I6, I7,
// I12). A forest is a project, a tree is a root task, branches are its subtask
// descendants and links. Felling moves a whole tree into a flat, read-only log
// plus seeds; nothing here has an update path, so a log cannot grow (N-010).
import { createId } from "@paralleldrive/cuid2";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  MirrorRunReport,
  MirrorRunStatus,
} from "../import/notion-mirror/mirror-report";
import { taskTable, userTable, workspaceTable } from "./schema";

const utcNow = sql`(now() AT TIME ZONE 'utc')`;

// One row per task, kept for the task's life so the fencing token only grows
// (I6). The lease is live while expires_at is in the future; sessions sharing
// a group_key edit together under one token (R-026 linked sessions).
export const taskLeaseTable = pgTable(
  "task_lease",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    holderId: text("holder_id").notNull(),
    holderName: text("holder_name").notNull(),
    holderKind: text("holder_kind").notNull(),
    groupKey: text("group_key"),
    fencingToken: integer("fencing_token").notNull().default(1),
    acquiredAt: timestamp("acquired_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  },
  (table) => [index("task_lease_expires_at_idx").on(table.expiresAt)],
);

// An agent asks; only the owner's own session answers (N-011). An approval
// is bound to one action and one parameter hash and is consumed once.
export const ownerApprovalTable = pgTable(
  "owner_approval",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    paramsHash: text("params_hash").notNull(),
    // What the owner is asked to allow beyond the target, e.g. the closing
    // status or the new priority; shown to the owner, also in the hash.
    params: jsonb("params").$type<Record<string, string>>(),
    reason: text("reason"),
    requestedByKind: text("requested_by_kind").notNull(),
    requestedById: text("requested_by_id").notNull(),
    requestedByName: text("requested_by_name").notNull(),
    status: text("status").notNull().default("pending"),
    decidedByUserId: text("decided_by_user_id").references(() => userTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    decidedVia: text("decided_via"),
    decidedAt: timestamp("decided_at", { mode: "date" }),
    consumedAt: timestamp("consumed_at", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    // Millisecond precision: list cursors carry a JS Date (ms), so a µs
    // value would fall between two pages.
    createdAt: timestamp("created_at", { mode: "date", precision: 3 })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("owner_approval_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("owner_approval_target_idx").on(table.targetType, table.targetId),
  ],
);

// Canopy View: trees joined by their branches' links. It never changes a
// tree's parent, status or rights, and stays inside one workspace (R-002).
export const sectorTable = pgTable(
  "sector",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    name: text("name").notNull(),
    detectedBy: text("detected_by").notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("active"),
    fellingId: text("felling_id"),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("sector_workspace_status_idx").on(table.workspaceId, table.status),
    uniqueIndex("sector_workspace_active_signature_unique")
      .on(table.workspaceId, table.signature)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const sectorTreeTable = pgTable(
  "sector_tree",
  {
    sectorId: text("sector_id")
      .notNull()
      .references(() => sectorTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    primaryKey({ columns: [table.sectorId, table.taskId] }),
    index("sector_tree_task_id_idx").on(table.taskId),
  ],
);

// The explicit felling command and its event (I7: no hidden deletion).
export const fellingTable = pgTable(
  "felling",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(),
    sectorId: text("sector_id"),
    approvalId: text("approval_id").references(() => ownerApprovalTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    reason: text("reason").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    treeCount: integer("tree_count").notNull(),
    taskCount: integer("task_count").notNull(),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [index("felling_workspace_id_idx").on(table.workspaceId)],
);

// A felled tree, stored flat. Project and task ids are plain text on purpose:
// the log outlives them and must not cascade away with them.
export const timberLogTable = pgTable(
  "timber_log",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    fellingId: text("felling_id")
      .notNull()
      .references(() => fellingTable.id, {
        onDelete: "no action",
        onUpdate: "cascade",
      }),
    sourceProjectId: text("source_project_id").notNull(),
    sourceProjectName: text("source_project_name").notNull(),
    sourceTaskId: text("source_task_id").notNull(),
    taskNumber: integer("task_number"),
    title: text("title").notNull(),
    finalStatus: text("final_status").notNull(),
    priority: text("priority").notNull(),
    description: text("description"),
    fields: jsonb("fields").notNull(),
    history: jsonb("history").notNull(),
    felledTaskIds: jsonb("felled_task_ids").$type<string[]>().notNull(),
    searchText: text("search_text").notNull(),
    // Millisecond precision for the list cursor, as for approvals.
    felledAt: timestamp("felled_at", { mode: "date", precision: 3 })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("timber_log_workspace_felled_at_idx").on(
      table.workspaceId,
      table.felledAt,
    ),
    uniqueIndex("timber_log_source_task_id_unique").on(table.sourceTaskId),
    // A stale fenced write names any task of the felled tree, not only the root.
    index("timber_log_felled_task_ids_idx").using(
      "gin",
      sql`${table.felledTaskIds} jsonb_path_ops`,
    ),
  ],
);

// What agents and people did or were refused (R-036, AC-021, AC-027). A
// refusal is written outside the rolled-back transaction, so it survives.
export const agentJournalTable = pgTable(
  "agent_journal",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaceTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("agent_journal_workspace_created_at_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    // Who wrote a task's text: the agent guard asks by target (N-004).
    index("agent_journal_target_idx").on(table.targetType, table.targetId),
  ],
);

// Branches compressed beside their log (R-028). Derived data (I9): a later
// compressor writes a new revision instead of rewriting this one. Reading a
// seed needs access to every source project — the strictest rights (I12).
export const seedTable = pgTable(
  "seed",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    logId: text("log_id")
      .notNull()
      .references(() => timberLogTable.id, {
        onDelete: "no action",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sourceTaskIds: jsonb("source_task_ids").$type<string[]>().notNull(),
    sourceProjectIds: jsonb("source_project_ids").$type<string[]>().notNull(),
    contentHash: text("content_hash").notNull(),
    compressor: text("compressor").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    index("seed_log_id_idx").on(table.logId),
    index("seed_workspace_id_idx").on(table.workspaceId),
  ],
);

// A tree of a new forest grown from a seed points back at it (R-028).
export const treeOriginTable = pgTable("tree_origin", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => taskTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  seedId: text("seed_id")
    .notNull()
    .references(() => seedTable.id, {
      onDelete: "no action",
      onUpdate: "cascade",
    }),
  logId: text("log_id")
    .notNull()
    .references(() => timberLogTable.id, {
      onDelete: "no action",
      onUpdate: "cascade",
    }),
});

// What a Notion card carries on top of kaneo's title, status and priority
// (R-024), plus what an agent reports about its work on the card. One row per
// task, created on the first write. notion_page_id marks a mirrored card: the
// import keys on it (R-080) and its Notion fields stay read-only (R-081).
export const cardMetaTable = pgTable(
  "card_meta",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").$type<"task" | "bug">().notNull().default("task"),
    severity: text("severity"),
    backlogId: text("backlog_id"),
    halfBaked: boolean("half_baked").notNull().default(false),
    report: text("report"),
    notionPageId: text("notion_page_id"),
    notionStatus: text("notion_status"),
    // The page's last_edited_time at the last import: a re-import rewrites the
    // card only when Notion edited it since (R-080).
    notionEditedAt: timestamp("notion_edited_at", { mode: "date" }),
    executor: text("executor"),
    branch: text("branch"),
    pullRequests: jsonb("pull_requests")
      .$type<string[]>()
      .notNull()
      .default([]),
    files: jsonb("files").$type<string[]>().notNull().default([]),
    tokens: integer("tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 4 }),
    contextPack: text("context_pack"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    uniqueIndex("card_meta_workspace_backlog_id_idx").on(
      table.workspaceId,
      table.backlogId,
    ),
    uniqueIndex("card_meta_notion_page_id_idx").on(table.notionPageId),
    index("card_meta_workspace_kind_idx").on(table.workspaceId, table.kind),
  ],
);

// Every edit of a card's content or fields (R-023, AC-009). Database triggers
// write the rows, so no edit path can skip them: task rows on a revision bump,
// meta rows on any change of card_meta. `changes` keeps only what the edit
// changed, as {field: {from, to}}, so a rollback can tell when a later edit
// touched the same field. actor_id is null for kaneo's own routes until the
// agent guard names the agent (people stay null; kaneo's activity names them).
export const cardHistoryTable = pgTable(
  "card_history",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").$type<"task" | "meta">().notNull(),
    // task rows: the revision this edit replaced.
    revision: integer("revision"),
    changes: jsonb("changes")
      .$type<Record<string, { from: unknown; to: unknown }>>()
      .notNull(),
    actorId: text("actor_id"),
    // clock_timestamp, not now(): two edits in one transaction still sort.
    createdAt: timestamp("created_at", { mode: "date" })
      .default(sql`(clock_timestamp() AT TIME ZONE 'utc')`)
      .notNull(),
  },
  (table) => [
    index("card_history_task_created_at_idx").on(table.taskId, table.createdAt),
    // A leaked key: every edit under it (spec, line on revoked keys).
    index("card_history_actor_idx").on(table.actorId),
  ],
);

// R-037: what each session is doing right now (its step, branch and what it
// waits for), one row per session, replaced on every write. It used to live
// in claude-mem work_state; the board owns it now. A row goes with its card.
export const sessionWorkStateTable = pgTable(
  "session_work_state",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    actorKind: text("actor_kind").notNull(),
    taskId: text("task_id").references(() => taskTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    step: text("step").notNull(),
    branch: text("branch"),
    waiting: text("waiting"),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.actorId] }),
    index("session_work_state_updated_at_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
  ],
);

// R-034: tools a session took beyond its role, at most five. The key is the
// role and a hash of the bearer token, never the token itself.
export const mcpToolGrantTable = pgTable(
  "mcp_tool_grant",
  {
    sessionKey: text("session_key").notNull(),
    tool: text("tool").notNull(),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionKey, table.tool] }),
    index("mcp_tool_grant_created_at_idx").on(table.createdAt),
  ],
);

// One row per run of the Notion mirror (AC-002, AC-003): the sync of every
// configured database, then a reconciliation of Notion against the board.
// The report names each discrepancy by page; the streak of clean runs is what
// the owner reads before the transition.
export const notionMirrorRunTable = pgTable(
  "notion_mirror_run",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    trigger: text("trigger").$type<"schedule" | "manual">().notNull(),
    status: text("status").$type<MirrorRunStatus>().notNull(),
    discrepancyCount: integer("discrepancy_count").notNull().default(0),
    report: jsonb("report")
      .$type<MirrorRunReport>()
      .notNull()
      .default({ databases: [] }),
    startedAt: timestamp("started_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
    finishedAt: timestamp("finished_at", { mode: "date" }),
  },
  (table) => [
    index("notion_mirror_run_workspace_started_idx").on(
      table.workspaceId,
      table.startedAt,
    ),
  ],
);

// R-010: an agent works under its own name. Each session of a harness gets a
// user of role "agent" that has no login; its keys are issued by its owner's
// key and its workspace roles follow the owner's, never above admin. A
// disabled agent keeps its history but gets no new keys. An agent idle for a
// day goes to the archive (TB-74): it keeps its history, holds no keys and no
// place under the owner's cap, and comes back when its session asks again.
export const agentProfileTable = pgTable(
  "agent_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    harness: text("harness").notNull(),
    session: text("session").notNull(),
    disabledAt: timestamp("disabled_at", { mode: "date" }),
    archivedAt: timestamp("archived_at", { mode: "date" }),
    lastIssuedAt: timestamp("last_issued_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" })
      .default(utcNow)
      .notNull(),
  },
  (table) => [index("agent_profile_owner_idx").on(table.ownerId)],
);
