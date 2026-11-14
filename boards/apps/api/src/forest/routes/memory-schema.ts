import { nullableResponseTimestamp, z } from "../../openapi";

// One claude-mem observation bound to the card (R-042): a pointer with the
// reason it matched, not the observation's text.
const memoryItemSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string().nullable().openapi({
    description:
      "The observation's title; a secret in it reads [REDACTED:<kind>].",
  }),
  subtitle: z.string().nullable().openapi({
    description: "Masked the same way as title.",
  }),
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
        "false when the claude-mem worker is unreachable and nothing was cached yet.",
    }),
    stale: z.boolean().openapi({
      description:
        "true when the worker is down and the list is a cached copy.",
    }),
    fetchedAt: nullableResponseTimestamp,
    scanned: z.number().int().openapi({
      description: "How many of the latest observations were checked.",
    }),
    items: z.array(memoryItemSchema),
  })
  .openapi("ForestCardMemory");
