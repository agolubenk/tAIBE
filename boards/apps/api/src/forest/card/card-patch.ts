import { z } from "../../openapi";
import { CARD_KINDS, type CardField } from "./card-fields";

const text = (max: number) => z.string().trim().min(1).max(max);

const cardMetaFields = {
  kind: z.enum(CARD_KINDS).optional().openapi({
    description: "bug: a card from the Notion «Ошибки» board.",
  }),
  severity: text(32).nullable().optional(),
  backlogId: z
    .string()
    .regex(/^[\p{L}\p{N}._-]{1,64}$/u)
    .nullable()
    .optional()
    .openapi({ description: "Notion Backlog ID, unique in the workspace." }),
  halfBaked: z.boolean().optional().openapi({
    description:
      "A raw idea: agents do not take it into work. Only the owner's own session changes it.",
  }),
  report: z.string().max(20_000).nullable().optional(),
  executor: text(200).nullable().optional(),
  branch: text(200).nullable().optional(),
  pullRequests: z.array(text(500)).max(20).optional(),
  files: z.array(text(500)).max(200).optional().openapi({
    description: "Touched files, path or path:line.",
  }),
  tokens: z.number().int().min(0).nullable().optional(),
  costUsd: z.number().min(0).max(1e8).nullable().optional(),
  contextPack: text(2000).nullable().optional(),
};

export const cardMetaPatch = z
  .object(cardMetaFields)
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "send at least one field",
  });

export type CardMetaPatch = z.output<typeof cardMetaPatch>;

// The PUT body: the fields plus the revision the writer read (TB-142).
export const cardMetaWrite = z
  .object({
    ...cardMetaFields,
    expectedMetaRevision: z.iso.datetime().nullable().optional().openapi({
      description:
        "The revision from the read. If the fields changed since, the write is refused with 409 revision_conflict and the current revision. null: write only if the card has no fields yet. Omitted: no check.",
    }),
  })
  .strict()
  .refine(
    ({ expectedMetaRevision: _, ...patch }) => Object.keys(patch).length > 0,
    { message: "send at least one field" },
  );

export function patchFields(patch: CardMetaPatch) {
  return Object.keys(patch) as CardField[];
}
