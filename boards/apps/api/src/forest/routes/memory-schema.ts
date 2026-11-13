import {
  BOARD_KEY_PATTERN,
  QUEUE_ITEM_ID_PATTERN,
} from "@kaneo/claude-mem-reader";
import { nullableResponseTimestamp, z } from "../../openapi";
import { workspaceParam } from "./schema";

// One claude-mem observation that names a key: a pointer and its title,
// never the observation's text (TB-113).
const memoryLineSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable().openapi({
    description: "The observation's title, at most 120 characters.",
  }),
  project: z.string(),
  createdAt: z.string(),
});

const memoryKeySchema = z.object({
  key: z.string().openapi({
    description: "The card id, card key (TB-108) or owner-queue item id.",
  }),
  matchedOn: z.enum(["id", "key", "queue"]),
  count: z.number().int().openapi({
    description: "Observations that name the key exactly, at most 500.",
  }),
  capped: z.boolean().openapi({
    description:
      "true when more than 500 observations name the key; latest is then approximate.",
  }),
  latest: z.array(memoryLineSchema).openapi({
    description: "Up to 5, newest first.",
  }),
});

export const cardMemorySchema = z
  .object({
    available: z.boolean().openapi({
      description:
        "false when the Mac memory proxy is unreachable and no answer from the last 24 hours is kept.",
    }),
    stale: z.boolean().openapi({
      description:
        "true when the proxy is unreachable and the keys are the last answer, at most 24 hours old.",
    }),
    fetchedAt: nullableResponseTimestamp,
    keys: z.array(memoryKeySchema),
  })
  .openapi("ForestCardMemory");

export const memoryLookupParam = workspaceParam;

// Exactly one of the two; the handler refuses both or neither with 400.
export const memoryLookupQuery = z.object({
  // The same form as the card's memory keys: a key outside it would be
  // searched under other keys and answered as if it had none (400 instead).
  ticketKey: z
    .string()
    .trim()
    .toUpperCase()
    .regex(BOARD_KEY_PATTERN)
    .optional()
    .openapi({
      description:
        "A card key of this workspace, e.g. TB-108: a project key of 1 to 10 Latin letters and digits, a hyphen and the number.",
    }),
  queueItemId: z.string().regex(QUEUE_ITEM_ID_PATTERN).optional().openapi({
    description: "An owner-queue item id, e.g. d-tb113-mem-1311.",
  }),
});
