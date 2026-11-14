import { z } from "../openapi";

// TB-135: the limits of one batch. A stdio server sends at most 20 calls at a
// time; 50 leaves room and keeps one insert small.
export const MAX_CALLS = 50;

export const mcpCallInput = z.object({
  id: z.uuid().openapi({
    description:
      "The caller's id for this call. The same id sent again (a batch retried after a lost answer) adds no second row.",
  }),
  tool: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .openapi({ description: "The MCP tool that was called." }),
  args: z.unknown().openapi({
    description:
      "The arguments as sent. Secrets are replaced by a label and the text is cut before it is stored.",
  }),
  ok: z.boolean().openapi({ description: "False when the tool refused." }),
  bytes: z.number().int().min(0).max(100_000_000),
  tokens: z.number().int().min(0).max(100_000_000).openapi({
    description: "Tokens of the answer, counted with o200k_base (D-018).",
  }),
  ms: z.number().int().min(0).max(86_400_000),
});

export type McpCallInput = z.infer<typeof mcpCallInput>;

export const mcpCallsBody = z
  .object({ calls: z.array(mcpCallInput).min(1).max(MAX_CALLS) })
  .openapi("AgentJournalMcpCalls");

export const mcpCallsResult = z
  .object({
    received: z.number().int(),
    journaled: z.number().int().openapi({
      description:
        "New rows. Calls already journaled under the same id are not counted again.",
    }),
  })
  .openapi("AgentJournalMcpCallsResult");
