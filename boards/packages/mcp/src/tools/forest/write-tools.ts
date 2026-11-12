import { z } from "zod";
import type { ToolClient } from "../register.js";
import { type RegisterTool, run } from "../register-tool.js";
import { forestCall, id, sessionField } from "./request.js";

const reason = z.string().trim().min(1).max(2000);

export function registerForestWriteTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "forest_acquire_lease",
    {
      description:
        "Take or renew the write lease on a task before editing it. Linked sessions share one lease by sending the same groupKey. A conflict names the holder; a lapsed lease is taken over with a higher fencingToken.",
      inputSchema: z.object({
        workspaceId: id,
        taskId: id,
        session: sessionField,
        groupKey: z.string().trim().min(1).max(120).optional(),
        ttlSeconds: z.number().int().min(30).max(1800).optional(),
      }),
    },
    ({ workspaceId, session, ...body }) =>
      run(() => forestCall(client, workspaceId, "/leases", { body, session })),
  );

  registerTool(
    "forest_release_lease",
    {
      description:
        "End your lease early. A stale fencingToken releases nothing (released: false).",
      inputSchema: z.object({
        workspaceId: id,
        taskId: id,
        session: sessionField,
        fencingToken: z.number().int().positive(),
      }),
    },
    ({ workspaceId, session, ...body }) =>
      run(() =>
        forestCall(client, workspaceId, "/leases/release", { body, session }),
      ),
  );

  registerTool(
    "forest_request_approval",
    {
      description:
        "Ask the owner for a «да»: fell a tree (root task with its subtasks) or a sector, close a task (move it to a final column or archived), reopen a closed one, change its priority, or a one-time grant: create_label, attach_label, set_assignee. Only the owner answers — in the t-boards UI or in the owner queue, where the server puts the request itself (never add a queue item for it). On «да» the server applies the action itself, the whole path to the target status included; do not repeat the write. Read the outcome with forest_list_approvals: consumed (applied), rejected, failed (failReason) or expired. close_task needs doneRef or doneReason.",
      inputSchema: z.object({
        workspaceId: id,
        action: z.enum([
          "fell_tree",
          "fell_sector",
          "close_task",
          "reopen_task",
          "set_priority",
          "create_label",
          "attach_label",
          "set_assignee",
        ]),
        targetId: id.describe(
          "Root task id, sector id, the task to close, reopen, reprioritize or assign; create_label: the workspace id; attach_label: the workspace label id.",
        ),
        value: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "close_task: the closing status; reopen_task: the open status the closed task returns to; set_priority: the new priority; set_assignee: the user id. The «да» covers only this value.",
          ),
        label: z
          .object({
            name: z.string().trim().min(1).max(64),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          })
          .optional()
          .describe("create_label: the new workspace label."),
        taskIds: z
          .array(id)
          .min(1)
          .max(20)
          .optional()
          .describe(
            "create_label, attach_label: the cards that get the label.",
          ),
        doneRef: z
          .string()
          .max(200)
          .optional()
          .describe(
            "close_task: https://github.com/agolubenk/(HR_Helper-v2|tAIBE)/(commit/<sha>|pull/<n>) with the docs/plans/done entry.",
          ),
        doneReason: z
          .enum(["duplicate", "obsolete", "import"])
          .optional()
          .describe("close_task without a done entry: why there is none."),
        reason,
        session: sessionField.optional(),
      }),
    },
    ({ workspaceId, session, ...body }) =>
      run(() =>
        forestCall(client, workspaceId, "/approvals", { body, session }),
      ),
  );

  registerTool(
    "forest_fell",
    {
      description:
        "Fell a tree or sector from the owner's own session. Agents do not fell: request fell_tree or fell_sector with forest_request_approval and the server fells on the owner's «да»; a live lease on any of its tasks blocks felling.",
      inputSchema: z.object({
        workspaceId: id,
        kind: z.enum(["tree", "sector"]),
        targetId: id.describe(
          "Root task id for a tree, sector id for a sector.",
        ),
        approvalId: id,
        reason,
        session: sessionField.optional(),
      }),
    },
    ({ workspaceId, session, kind, targetId, approvalId, reason }) =>
      run(() =>
        forestCall(client, workspaceId, "/fell", {
          session,
          body:
            kind === "tree"
              ? { kind, rootId: targetId, approvalId, reason }
              : { kind, sectorId: targetId, approvalId, reason },
        }),
      ),
  );

  registerTool(
    "forest_detect_sectors",
    {
      description:
        "Recompute sectors: groups of trees joined by blocks/related links. Groups that no longer exist turn stale.",
      inputSchema: z.object({ workspaceId: id }),
    },
    ({ workspaceId }) =>
      run(() =>
        forestCall(client, workspaceId, "/sectors/detect", { body: {} }),
      ),
  );

  registerTool(
    "forest_grow",
    {
      description:
        "Grow a new project from seeds of felled logs: one to-do task per seed, linked back to its log.",
      inputSchema: z.object({
        workspaceId: id,
        seedIds: z.array(id).min(1).max(100),
        name: z.string().trim().min(1).max(120),
        slug: z.string().trim().min(1).max(20),
        icon: z.string().trim().min(1).max(40).optional(),
      }),
    },
    ({ workspaceId, ...body }) =>
      run(() => forestCall(client, workspaceId, "/grow", { body })),
  );
}
