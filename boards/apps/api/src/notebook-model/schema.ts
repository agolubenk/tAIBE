import { isHttpsUrl } from "../notebook/llm/base-url";
import { z } from "../openapi";

export const notebookModelSchema = z
  .object({
    baseUrl: z.string(),
    model: z.string().nullable(),
    embedModel: z.string(),
    dailyMax: z.number().int(),
    hasKey: z.boolean(),
    keySource: z.enum(["settings", "file"]).nullable().openapi({
      description:
        "Where the model key comes from: these settings, or the server's key file. The key itself is never returned.",
    }),
    keyUnreadable: z.boolean().openapi({
      description:
        "A key is stored but cannot be opened: the server's settings key or the API address changed since it was saved. Enter the key again.",
    }),
    fileKeyWithheld: z.boolean().openapi({
      description:
        "The server's key file holds a key for the server's own API address; it is not sent to the address set here.",
    }),
    canStoreKey: z.boolean().openapi({
      description:
        "The server has a settings encryption key, so a model key can be saved here.",
    }),
    callsToday: z.number().int(),
    usage: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string(),
        calls: z.number().int(),
        withUsage: z.number().int().openapi({
          description:
            "Calls of today whose provider reported token usage; the token sums are over these calls only.",
        }),
        input: z.number().int().openapi({
          description:
            "Prompt tokens the provider reported today, the cached part included (D-018).",
        }),
        output: z.number().int().openapi({
          description: "Completion tokens the provider reported today.",
        }),
        cached: z.number().int().openapi({
          description:
            "The part of input the provider read from its cache; priced lower.",
        }),
      }),
    ),
  })
  .openapi("NotebookModelSettings");

const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

export const updateNotebookModelBody = z
  .object({
    baseUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine(isHttpsUrl, { message: "The API address must use https" })
      .nullable()
      .optional()
      .openapi({
        description:
          "An https address of an OpenAI-compatible API. A stored key is bound to it: changing it needs the key again.",
      }),
    model: optionalText(200),
    embedModel: optionalText(200),
    dailyMax: z.number().int().min(0).max(100_000).nullable().optional(),
    key: z.string().trim().min(1).max(500).nullable().optional().openapi({
      description:
        "A new model key; null removes the stored one, leaving it out keeps it.",
    }),
  })
  .openapi("UpdateNotebookModelSettings");

export type UpdateNotebookModel = z.infer<typeof updateNotebookModelBody>;
