import { isHttpsUrl } from "../notebook/llm/base-url";
import { z } from "../openapi";
import { CHAIN_POINTS_MAX, MODEL_NAMES_MAX } from "./notebook-model-store";

const keySourceSchema = z.enum(["settings", "file"]).nullable().openapi({
  description:
    "Where the model key comes from: these settings, or the server's key file. The key itself is never returned.",
});

const fileKeyWithheldSchema = z.boolean().openapi({
  description:
    "The server's key file holds a key for the server's own API address; it is not sent to the address set here.",
});

const modelNamesSchema = z.array(z.string()).openapi({
  description:
    "OpenRouter's own fallback models for this point, tried there in order. Sent only to openrouter.ai.",
});

const failsSchema = z.number().int().openapi({
  description:
    "Failed calls of this point since the API started (kept in memory).",
});

export const notebookModelPointSchema = z
  .object({
    id: z.string(),
    baseUrl: z.string(),
    model: z.string(),
    models: modelNamesSchema,
    hasKey: z.boolean(),
    keySource: keySourceSchema,
    keyUnreadable: z.boolean(),
    fileKeyWithheld: fileKeyWithheldSchema,
    callsToday: z.number().int().openapi({
      description:
        "Today's calls (UTC) answered or last failed by a model this point lists first in the chain.",
    }),
    failsSinceStart: failsSchema,
  })
  .openapi("NotebookModelPoint");

export const notebookModelSchema = z
  .object({
    baseUrl: z.string(),
    model: z.string().nullable(),
    models: modelNamesSchema,
    embedModel: z.string(),
    dailyMax: z.number().int(),
    hasKey: z.boolean(),
    keySource: keySourceSchema,
    keyUnreadable: z.boolean().openapi({
      description:
        "A key is stored but cannot be opened: the server's settings key or the API address changed since it was saved. Enter the key again.",
    }),
    fileKeyWithheld: fileKeyWithheldSchema,
    canStoreKey: z.boolean().openapi({
      description:
        "The server has a settings encryption key, so a model key can be saved here.",
    }),
    callsToday: z.number().int().openapi({
      description: "Today's model calls (UTC) of all points: the daily cap.",
    }),
    pointCallsToday: z.number().int().openapi({
      description:
        "The part of callsToday answered or last failed by the main point.",
    }),
    failsSinceStart: failsSchema,
    chain: z.array(notebookModelPointSchema).openapi({
      description:
        "Points tried in this order after the main one fails (TB-159). The daily cap is shared by all points.",
    }),
    usage: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string(),
        calls: z.number().int(),
      }),
    ),
  })
  .openapi("NotebookModelSettings");

const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine(isHttpsUrl, { message: "The API address must use https" });

const modelNamesBody = z
  .array(z.string().trim().min(1).max(200))
  .max(MODEL_NAMES_MAX);

const keyBody = z.string().trim().min(1).max(500).nullable().optional();

const modelPointBody = z.object({
  id: z.string().min(1).max(64).optional().openapi({
    description:
      "The id of a point already in the chain; leave it out for a new point.",
  }),
  baseUrl: httpsUrl.openapi({
    description:
      "An https address of an OpenAI-compatible API. The point's key is bound to it.",
  }),
  model: z.string().trim().min(1).max(200),
  models: modelNamesBody.optional(),
  key: keyBody.openapi({
    description:
      "A new key for this point; null removes it, leaving it out keeps the point's stored key (same address only).",
  }),
});

export const updateNotebookModelBody = z
  .object({
    baseUrl: httpsUrl.nullable().optional().openapi({
      description:
        "An https address of an OpenAI-compatible API. A stored key is bound to it: changing it needs the key again.",
    }),
    model: optionalText(200),
    models: modelNamesBody.nullable().optional().openapi({
      description:
        "OpenRouter's own fallback models for the main point; null or an empty list removes them.",
    }),
    embedModel: optionalText(200),
    dailyMax: z.number().int().min(0).max(100_000).nullable().optional(),
    key: keyBody.openapi({
      description:
        "A new model key; null removes the stored one, leaving it out keeps it.",
    }),
    chain: z
      .array(modelPointBody)
      .max(CHAIN_POINTS_MAX)
      .nullable()
      .optional()
      .openapi({
        description:
          "The whole chain after the main point, in the order to try it; null removes it, leaving it out keeps it.",
      }),
  })
  .openapi("UpdateNotebookModelSettings");

export type UpdateNotebookModel = z.infer<typeof updateNotebookModelBody>;
export type UpdateModelPoint = z.infer<typeof modelPointBody>;
