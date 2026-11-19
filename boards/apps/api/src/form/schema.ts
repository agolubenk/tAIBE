import { answersDocSchema, formTemplateSchema, LIMITS } from "@kaneo/forms";
import { z } from "../openapi";

// R-027 (TB-173): the template and the answers are checked by @kaneo/forms,
// the same code the web runs.

/** A template is at most 200 fields; the grill's 53 fields are 21 KB. */
export const TEMPLATE_BODY_MAX = 256 * 1024;
/** Answers: the same limit the web checks before it sends (LIMITS.answersBody). */
export const ANSWERS_BODY_MAX = LIMITS.answersBody;

export const workspaceIdParam = z.object({ workspaceId: z.string() });

export const taskIdParam = z.object({ taskId: z.string() });

export const taskFormIdParam = z.object({ id: z.string() });

export const createTemplateBody = z.object({
  template: formTemplateSchema,
});

export const attachFormBody = z.object({
  templateId: z.string().min(1).openapi({
    description: "A template of the task's workspace.",
  }),
});

export const saveAnswersBody = z.object({
  answers: answersDocSchema,
  submit: z.boolean().openapi({
    description:
      "false: a draft (autosave): no required check, answers to hidden fields stay. true: the full check; the form becomes submitted.",
  }),
  rowVersion: z
    .number()
    .int()
    .min(0)
    .openapi({ description: "The rowVersion the form was read with." }),
});
