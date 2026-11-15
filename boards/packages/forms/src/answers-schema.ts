import { z } from "zod";
import { LIMITS } from "./limits";
import { fieldIdSchema } from "./schema";

// The zod schemas of an answer and an answer document, for the API. The
// answer checks in answers.ts use only the types, so the web, which never
// parses answers, does not load these schemas (TB-173, #357 bundle).

export const answerSchema = z.strictObject({
  v: z.unknown(),
  note: z.string().max(LIMITS.note).optional(),
});
export type Answer = z.infer<typeof answerSchema>;

export const answersDocSchema = z.strictObject({
  form: z.string().min(1).max(80),
  version: z.number().int().min(1),
  answers: z.record(fieldIdSchema, answerSchema),
});
export type AnswersDoc = z.infer<typeof answersDocSchema>;
