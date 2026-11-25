import { pagingNumber, z } from "../../openapi";
import {
  OWNER_QUEUE_COLLECTIONS,
  OWNER_QUEUE_STATES,
} from "../owner-queue/owner-queue-view";
import { workspaceParam } from "./schema";

// TB-156: the owner's queue, read through the ops-console API (spec
// owner-queue-move §5.6).

export const ownerQueueListParam = workspaceParam.extend({
  collection: z.enum(OWNER_QUEUE_COLLECTIONS),
});

export const ownerQueueDocParam = ownerQueueListParam.extend({
  id: z.string().regex(/^[A-Za-z0-9_.~:@+-]{1,80}$/),
});

export const ownerQueueListQuery = z.object({
  state: z.enum(OWNER_QUEUE_STATES).optional(),
  product: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  page: pagingNumber(1, 1000).optional(),
});

const ownerQueueRowSchema = z.object({
  id: z.string(),
  product: z.string().nullable(),
  kind: z.string().nullable(),
  title: z.string(),
  added: z.string().nullable(),
  source: z.string().nullable(),
  pr: z.number().int().nullable(),
  inboxType: z.string().nullable(),
  state: z.enum(["open", "done"]).nullable().openapi({
    description:
      "open — in the console's open list (?open=1), done — not in it. Items only; null for checks.",
  }),
  choice: z.string().nullable(),
  done: z.boolean().nullable(),
  answeredAt: z.string().nullable(),
  updatedAt: z.number(),
});

export const ownerQueueListSchema = z
  .object({
    docs: z.array(ownerQueueRowSchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    order: z.enum(["oldest", "newest"]).openapi({
      description:
        "oldest — open items, oldest first as on the console's /queue (added, creation time, id); newest — the newest answer first (answered, all, checks).",
    }),
    total: z.number().int(),
    products: z.array(z.string()),
    truncated: z.boolean(),
    collectionTotal: z.number().int().nullable().openapi({
      description:
        "When the console capped the list: how many documents the collection has in all.",
    }),
    queueUrl: z.string().openapi({
      description: "The owner queue page in the ops-console.",
    }),
  })
  .openapi("OwnerQueueList");

const queueDocSchema = z.object({
  id: z.string(),
  data: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  updatedAt: z.number(),
  createdAt: z.number().optional(),
  product: z.string().optional(),
});

const queueEventSchema = z.object({
  at: z.number(),
  actor: z.string(),
  action: z.string(),
  after: z.record(z.string(), z.unknown()).nullable(),
});

export const ownerQueueDocSchema = z
  .object({
    doc: queueDocSchema,
    check: queueDocSchema.nullable(),
    history: z.array(queueEventSchema),
    checkHistory: z.array(queueEventSchema),
    files: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        size: z.number(),
        createdAt: z.string(),
      }),
    ),
    queueUrl: z.string(),
  })
  .openapi("OwnerQueueDoc");
