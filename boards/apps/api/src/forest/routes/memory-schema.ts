import { nullableResponseTimestamp, z } from "../../openapi";

// One claude-mem observation bound to the card (R-042): a pointer with the
// reason it matched, not the observation's text.
const memoryItemSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  createdAt: z.string(),
  matchedOn: z.enum(["branch", "task-id"]),
  matchedValue: z.string().openapi({
    description: "The card's branch or identifier the observation names.",
  }),
  source: z.enum(["metadata", "text"]),
});

export const cardMemorySchema = z
  .object({
    available: z.boolean().openapi({
      description:
        "false when the claude-mem worker is unreachable and nothing was cached yet, or when the workspace has no claude-mem projects.",
    }),
    reason: z
      .enum(["worker-unreachable", "no-product-map"])
      .nullable()
      .openapi({
        description:
          "Why available is false: no-product-map — CLAUDE_MEM_PROJECTS names no claude-mem projects for this workspace (R-002). null when available.",
      }),
    stale: z.boolean().openapi({
      description:
        "true when the worker is down and the list is a cached copy.",
    }),
    fetchedAt: nullableResponseTimestamp,
    scanned: z.number().int().openapi({
      description:
        "How many of the latest observations of the workspace's claude-mem projects were checked.",
    }),
    items: z.array(memoryItemSchema),
  })
  .openapi("ForestCardMemory");
