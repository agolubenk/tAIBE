import { z } from "../../openapi";

// TB-44 (R-036): a card's MCP spend from the journal.
export const cardCostSchema = z
  .object({
    taskId: z.string(),
    calls: z.number().int().openapi({
      description:
        "Answered MCP calls that named this card by taskId since TB-44.",
    }),
    tokens: z.number().int().openapi({
      description:
        "Tokens of those answers, counted with o200k_base (D-018): what agents read about the card, not what their models spent.",
    }),
    actors: z.array(
      z.object({
        actor: z.string().openapi({
          description: "Who called: bearer:<user id> for a remote MCP client.",
        }),
        calls: z.number().int(),
        tokens: z.number().int(),
        firstAt: z.string(),
        lastAt: z.string(),
      }),
    ),
    truncated: z.boolean().openapi({
      description: "More than 50 actors; the totals still count them all.",
    }),
    card: z
      .object({
        tokens: z.number().nullable(),
        costUsd: z.number().nullable(),
      })
      .openapi({
        description:
          "What the card's writers entered from provider usage: input + output tokens, cache priced into costUsd.",
      }),
  })
  .openapi("ForestCardCost");
