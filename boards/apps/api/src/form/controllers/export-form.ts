import { exportAnswers } from "@kaneo/forms";
import { loadTaskForm } from "./task-form-row";

/**
 * The grill's JSON export (t-boards-grill-answers.json). Stored answers were
 * checked on save, so every exported value fits its field. `at` is the
 * Submit, or the last save of a draft.
 */
export default async function exportForm(id: string) {
  const { form, template } = await loadTaskForm(id);
  const submitted = form.status === "submitted";
  const at = submitted && form.submittedAt ? form.submittedAt : form.updatedAt;
  return exportAnswers(template, form.answers ?? { answers: {} }, {
    submitted,
    at: at.toISOString(),
  });
}
