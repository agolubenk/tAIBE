import { z } from "zod";
import { sessionField } from "./forest/request.js";
import type { ToolClient } from "./register.js";

// Task writes from an agent run under its lease (AC-010), and closing a card or
// changing its priority also needs the owner's «да» (AC-008). The API reads
// these from headers, so the task bodies stay as upstream defines them. Names
// match apps/api/src/forest/agent-guard/agent-headers.ts.
const HEADERS = {
  session: "x-t-boards-session",
  fencingToken: "x-t-boards-fence",
  groupKey: "x-t-boards-group",
  expectedRevision: "x-t-boards-revision",
  approvalId: "x-t-boards-approval",
  note: "x-t-boards-note",
  link: "x-t-boards-link",
} as const;

export const GROUP_HEADER = HEADERS.groupKey;

// Header values are Latin-1, so the note travels percent-encoded.
const ENCODE: Partial<Record<keyof typeof HEADERS, (value: string) => string>> =
  { note: encodeURIComponent };

const AGENT_WRITE_TOOLS = new Set([
  "create_task",
  "update_task",
  "move_task",
  "update_task_status",
  "update_task_assignee",
  "update_task_due_date",
  "forest_set_card_meta",
]);

export function isAgentWriteTool(name: string) {
  return AGENT_WRITE_TOOLS.has(name);
}

export const agentWriteShape = {
  session: sessionField
    .optional()
    .describe("The session label the lease was taken with."),
  fencingToken: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Token from forest_acquire_lease. Edits of an existing task are refused without it.",
    ),
  groupKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("The groupKey of a lease shared by linked sessions."),
  expectedRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Refuse the write if the task moved past this revision."),
  approvalId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Kept for one release: the server applies the owner's «да» itself. With the id of an applied request the write answers «already applied» and changes nothing; a pending one answers 409.",
    ),
  note: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "On a status change: what was done or found. It goes to the card's comments at once, with a mention of your owner.",
    ),
  link: z
    .string()
    .trim()
    .url()
    .max(500)
    .optional()
    .describe(
      "On a status change: the PR, commit or other http(s) link to the work. Moving to review needs one, sent here or already on the card.",
    ),
};

export function splitAgentWrite(args: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const rest = { ...args };
  for (const [field, header] of Object.entries(HEADERS)) {
    const value = rest[field];
    delete rest[field];
    if (value === undefined) continue;
    const encode = ENCODE[field as keyof typeof HEADERS];
    headers[header] = encode ? encode(String(value)) : String(value);
  }
  return { headers, rest };
}

export function withHeaders(
  client: ToolClient,
  headers: Record<string, string>,
): ToolClient {
  if (Object.keys(headers).length === 0) return client;
  return {
    usingApiKey: client.usingApiKey,
    json: (path, init) => {
      const merged = new Headers(init?.headers);
      for (const [name, value] of Object.entries(headers))
        merged.set(name, value);
      return client.json(path, {
        ...init,
        headers: Object.fromEntries(merged),
      });
    },
  };
}
