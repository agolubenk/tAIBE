import {
  type AnswerIssueCode,
  answersDocSchema,
  formTemplateSchema,
} from "@kaneo/forms";
import { apiErrorSchema } from "../errors/api-error-schema";
import { nullableResponseTimestamp, responseTimestamp, z } from "../openapi";

const formStatusSchema = z.enum(["draft", "submitted"]).openapi({
  description:
    "draft until Submit passes the full check; any later save makes it a draft again.",
});

export const formTemplateRowSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    version: z.number().int(),
    title: z.string(),
    createdAt: responseTimestamp,
  })
  .openapi("FormTemplateRow");

export const taskFormSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    templateId: z.string(),
    template: formTemplateSchema,
    answers: answersDocSchema.nullable(),
    status: formStatusSchema,
    rowVersion: z.number().int(),
    submittedAt: nullableResponseTimestamp.openapi({
      description:
        "The last Submit. Set while status is draft: the form changed after it was submitted.",
    }),
  })
  .openapi("TaskForm");

export const taskFormListSchema = z
  .object({ forms: z.array(taskFormSchema) })
  .openapi("TaskFormList");

export const saveAnswersResponseSchema = z
  .object({
    status: formStatusSchema,
    rowVersion: z.number().int(),
    submittedAt: nullableResponseTimestamp,
  })
  .openapi("SaveFormAnswersResult");

const ANSWER_ISSUE_CODES = [
  "required",
  "wrong_type",
  "out_of_range",
  "invalid_option",
  "invalid_interval",
  "too_long",
  "unknown_field",
  "version_mismatch",
] as const satisfies readonly AnswerIssueCode[];

export const answersRejectedSchema = apiErrorSchema
  .extend({
    answerIssues: z
      .array(
        z.object({
          fieldId: z.string().nullable(),
          code: z.enum(ANSWER_ISSUE_CODES),
        }),
      )
      .openapi({
        description:
          "AnswerIssue[] of @kaneo/forms: stable codes, the web maps them to i18n keys.",
      }),
  })
  .openapi("FormAnswersRejected");

export const formExportSchema = z
  .object({
    form: z.string(),
    version: z.number().int(),
    submitted: z.boolean(),
    answered: z.number().int(),
    total: z.number().int(),
    at: z.string(),
    answers: z.array(
      z.object({
        id: z.string(),
        q: z.string(),
        v: z.unknown(),
        answer: z.unknown(),
        note: z.string(),
      }),
    ),
  })
  .openapi("FormExport", {
    description:
      "The grill questionnaire's export format: shown fields that have a value or a note.",
  });
