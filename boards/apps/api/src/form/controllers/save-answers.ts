import {
  type AnswerIssue,
  type AnswersDoc,
  validateAnswers,
} from "@kaneo/forms";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "../../database";
import { ApiError } from "../../errors/api-error";
import { loadTaskForm } from "./task-form-row";

export type SaveAnswersInput = {
  answers: AnswersDoc;
  submit: boolean;
  rowVersion: number;
};

type Saved = {
  status: "draft" | "submitted";
  rowVersion: number;
  submittedAt: Date | null;
};

/**
 * TB-173 F1/F2: a draft (autosave) skips `required` and keeps answers to
 * hidden fields; Submit runs the full check and drops them. Any save after
 * a Submit makes the form a draft again and keeps submittedAt, so the card
 * can say "changed after submit". rowVersion is a compare-and-set: two tabs
 * never overwrite each other silently.
 */
export default async function saveAnswers(
  id: string,
  input: SaveAnswersInput,
  userId: string,
): Promise<{ saved: Saved } | { issues: AnswerIssue[] }> {
  const { template } = await loadTaskForm(id);
  if (
    input.answers.form !== template.form ||
    input.answers.version !== template.version
  ) {
    throw new ApiError(409, {
      message: `The form is ${template.form} version ${template.version}: reload it.`,
      code: "VERSION_MISMATCH",
    });
  }
  const check = validateAnswers(template, input.answers, {
    draft: !input.submit,
  });
  if (!check.ok) return { issues: check.issues };

  const forms = schema.taskFormTable;
  const [saved] = await db
    .update(forms)
    .set({
      answers: {
        form: template.form,
        version: template.version,
        answers: check.answers,
      },
      status: input.submit ? "submitted" : "draft",
      rowVersion: sql`${forms.rowVersion} + 1`,
      updatedBy: userId,
      ...(input.submit
        ? { submittedAt: new Date(), submittedBy: userId }
        : {}),
    })
    .where(and(eq(forms.id, id), eq(forms.rowVersion, input.rowVersion)))
    .returning({
      status: forms.status,
      rowVersion: forms.rowVersion,
      submittedAt: forms.submittedAt,
    });
  if (!saved) {
    throw new ApiError(409, {
      message:
        "The form changed in another tab or by another person: reload it.",
      code: "ROW_VERSION_CONFLICT",
    });
  }
  return { saved };
}
