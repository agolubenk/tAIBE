import { z } from "zod";
import type { ToolClient } from "../register.js";
import type { RegisterTool } from "../register-tool.js";
import { run } from "../register-tool.js";
import { forestCall, id } from "./request.js";

const text = (max: number) => z.string().trim().min(1).max(max);

// The same limits as apps/api/src/forest/card/card-patch.ts; the API decides.
const cardFields = {
  kind: z
    .enum(["task", "bug"])
    .optional()
    .describe("bug: a card from «Ошибки»."),
  severity: text(32).nullable().optional(),
  backlogId: z
    .string()
    .regex(/^[\p{L}\p{N}._-]{1,64}$/u)
    .nullable()
    .optional()
    .describe("Notion Backlog ID, unique in the workspace."),
  report: z.string().max(20_000).nullable().optional(),
  executor: text(200).nullable().optional(),
  branch: text(200).nullable().optional(),
  pullRequests: z.array(text(500)).max(20).optional(),
  files: z
    .array(text(500))
    .max(200)
    .optional()
    .describe("Touched files, path or path:line."),
  tokens: z.number().int().min(0).nullable().optional(),
  costUsd: z.number().min(0).max(1e8).nullable().optional(),
  contextPack: text(2000).nullable().optional(),
};

const cardPath = (taskId: string, part = "meta") =>
  `/cards/${encodeURIComponent(taskId)}/${part}`;

export function registerForestCardTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "forest_get_card_meta",
    {
      description:
        "Get a card's Notion fields (kind, severity, Backlog ID, half-baked, report) and agent fields (executor, branch, PRs, files, tokens, cost, context pack). A half-baked card is not to be taken into work.",
      inputSchema: z.object({ workspaceId: id, taskId: id }),
    },
    // The card is its task: answering taskId as id lets fields/since apply.
    ({ workspaceId, taskId }) =>
      run(async () => {
        const meta = await forestCall(client, workspaceId, cardPath(taskId));
        const { taskId: id, ...rest } = meta as { taskId: string };
        return { id, ...rest };
      }),
  );

  registerTool(
    "forest_get_context",
    {
      description:
        "Everything to pick up a card in one read: the task with labels, its card fields, the live lease, pending «да» requests, linked cards, the latest comments and which fields the latest edits changed. Lists are capped; `truncated` names the ones that had more. Use since to get only what changed, budget to cap the answer.",
      inputSchema: z.object({ workspaceId: id, taskId: id }),
    },
    ({ workspaceId, taskId }) =>
      run(() => forestCall(client, workspaceId, cardPath(taskId, "context"))),
  );

  registerTool(
    "forest_get_card_memory",
    {
      description:
        "Count the claude-mem observations that name a card or an owner-queue item exactly, with the 5 newest titles per key, never the text. Give exactly one of taskId, ticketKey (TB-108) or queueItemId (d-tb113-mem-1311). A card is searched by its id, board key, Backlog ID and the queue items of its «да» requests. stale: true means the Mac memory proxy is down and this is the last answer, at most 24 hours old.",
      inputSchema: z.object({
        workspaceId: id,
        taskId: id.optional(),
        ticketKey: id.optional(),
        queueItemId: id.optional(),
      }),
    },
    ({ workspaceId, taskId, ticketKey, queueItemId }) =>
      run(async () => {
        const given = [taskId, ticketKey, queueItemId].filter(Boolean);
        if (given.length !== 1) {
          throw new Error(
            "Give exactly one of taskId, ticketKey and queueItemId",
          );
        }
        if (taskId) {
          return forestCall(client, workspaceId, cardPath(taskId, "memory"));
        }
        return forestCall(client, workspaceId, "/memory", {
          query: { ticketKey, queueItemId },
        });
      }),
  );

  registerTool(
    "forest_set_card_meta",
    {
      description:
        "Change a card's fields under your lease (session, fencingToken). Send only what changes; null clears. Notion fields change only on cards you created and never on a card mirrored from Notion; half-baked is the owner's alone.",
      // Strict: a halfBaked or a misspelt field is refused, not dropped.
      inputSchema: z.strictObject({
        workspaceId: id,
        taskId: id,
        ...cardFields,
      }),
    },
    ({ workspaceId, taskId, ...body }, callClient) =>
      run(() =>
        forestCall(callClient, workspaceId, cardPath(taskId), {
          body,
          method: "PUT",
        }),
      ),
  );
}
