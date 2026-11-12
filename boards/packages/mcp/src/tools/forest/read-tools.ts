import { z } from "zod";
import type { ToolClient } from "../register.js";
import { type RegisterTool, run } from "../register-tool.js";
import { forestCall, id } from "./request.js";

const page = {
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe("nextCursor of the previous page"),
  take: z.number().int().min(1).max(100).optional(),
};

export function registerForestReadTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "forest_list_approvals",
    {
      description:
        "List approval requests, newest first. pending shows only requests that can still be answered.",
      inputSchema: z.object({
        workspaceId: id,
        status: z
          .enum([
            "pending",
            "approved",
            "rejected",
            "consumed",
            "failed",
            "expired",
          ])
          .optional(),
        ...page,
      }),
    },
    ({ workspaceId, ...query }) =>
      run(() => forestCall(client, workspaceId, "/approvals", { query })),
  );

  registerTool(
    "forest_list_logs",
    {
      description:
        "List felled trees (timber logs), newest first. q searches titles, descriptions and kept history.",
      inputSchema: z.object({
        workspaceId: id,
        q: z.string().trim().min(1).max(200).optional(),
        ...page,
      }),
    },
    ({ workspaceId, ...query }) =>
      run(() => forestCall(client, workspaceId, "/logs", { query })),
  );

  registerTool(
    "forest_get_log",
    {
      description: "Get one timber log with its compressed tree and its seeds.",
      inputSchema: z.object({ workspaceId: id, logId: id }),
    },
    ({ workspaceId, logId }) =>
      run(() =>
        forestCall(client, workspaceId, `/logs/${encodeURIComponent(logId)}`),
      ),
  );

  registerTool(
    "forest_list_sectors",
    {
      description: "List sectors (groups of linked trees) with their tree ids.",
      inputSchema: z.object({
        workspaceId: id,
        status: z.enum(["active", "stale", "felled"]).optional(),
      }),
    },
    ({ workspaceId, ...query }) =>
      run(() => forestCall(client, workspaceId, "/sectors", { query })),
  );
}
