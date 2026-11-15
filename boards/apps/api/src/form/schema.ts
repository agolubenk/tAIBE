import { answersDocSchema, formTemplateSchema } from "@kaneo/forms";
import { z } from "../openapi";

// R-027 (TB-173): the template and the answers are checked by @kaneo/forms,
// the same code the web runs.

/** A template is at most 200 fields; the grill's 53 fields are 21 KB. */
export const TEMPLATE_BODY_MAX = 256 * 1024;
/** Answers: up to 10 000 characters per text field; the grill is 37 KB. */
export const ANSWERS_BODY_MAX = 512 * 1024;

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
