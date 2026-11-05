import { z } from "../openapi";

export const issueAgentKeyBody = z
  .object({
    harness: z.string().min(1).max(40).openapi({
      description:
        "The harness the session runs in, as a lowercase slug: claude-code, codex, continue, cursor, kimi, copilot, roo or your own.",
      example: "claude-code",
    }),
    session: z.string().max(200).optional().openapi({
      description:
        "What the session calls itself (letters, digits, spaces and . _ : / # @ + -, up to 80). Without it the agent is named after the harness.",
      example: "successor bb",
    }),
  })
  .openapi("IssueAgentKeyBody");

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  harness: z.string(),
  session: z.string(),
});

export const issuedAgentKeySchema = z
  .object({
    agent: agentSchema,
    key: z.string().openapi({
      description: "The key itself, shown once; the server keeps only a hash.",
    }),
    keyId: z.string(),
    expiresAt: z.string().nullable(),
  })
  .openapi("IssuedAgentKey");

export const agentListSchema = z
  .array(
    agentSchema.extend({
      disabledAt: z.string().nullable().openapi({
        description:
          "When the owner disabled the agent; a disabled agent gets no keys until the owner enables it.",
      }),
      archivedAt: z.string().nullable().openapi({
        description:
          "When the agent went to the archive after a day without activity, or was enabled from disabled. An archived agent holds no keys and no place under the cap, and comes back when its session asks for a key.",
      }),
      lastIssuedAt: z.string().nullable(),
      createdAt: z.string(),
      keys: z.array(
        z.object({
          id: z.string(),
          start: z.string().nullable(),
          createdAt: z.string(),
          lastRequest: z.string().nullable(),
          expiresAt: z.string().nullable(),
        }),
      ),
    }),
  )
  .openapi("AgentList");

export const agentParam = z.object({ agentId: z.string().min(1) });

export const setAgentEnabledBody = z
  .object({ enabled: z.boolean() })
  .openapi("SetAgentEnabledBody");

export const agentEnabledSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    archived: z.boolean().openapi({
      description:
        "The agent is in the archive: it comes back when its session asks for a key.",
    }),
    revokedKeys: z.number(),
  })
  .openapi("AgentEnabled");

export const toolSetsSchema = z
  .object({
    header: z.string().openapi({
      description: "The request header an MCP client names its role in.",
    }),
    extraMax: z.number().openapi({
      description:
        "Tools a session may take beyond its role over its whole life.",
    }),
    roles: z.array(z.object({ role: z.string(), tools: z.array(z.string()) })),
  })
  .openapi("McpToolSets");
