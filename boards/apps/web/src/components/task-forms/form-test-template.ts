import { type FormTemplate, formTemplateSchema } from "@kaneo/forms";
import type { TaskForm } from "@/fetchers/task-form/get-task-forms";

/** A form with the seven field types and one display rule (TB-173 tests). */
export const sevenTypesTemplate: FormTemplate = formTemplateSchema.parse({
  form: "seven-types",
  version: 1,
  title: "Seven types",
  fields: [
    { id: "mood", type: "scale", q: "Mood", lo: "Bad", hi: "Good" },
    { id: "team", type: "yesno", q: "Do you have a team?", required: true },
    {
      id: "size",
      type: "input",
      kind: "number",
      q: "Team size",
      unit: "people",
      showIf: { field: "team", equals: true },
    },
    { id: "plan", type: "choice", q: "Plan", options: ["Free", "Pro"] },
    { id: "dates", type: "interval", kind: "date", q: "Dates" },
    { id: "name", type: "input", kind: "text", q: "Name", required: true },
    { id: "story", type: "text", q: "Story" },
    {
      id: "grid",
      type: "matrix",
      q: "Grid",
      rows: ["Speed", "Price"],
      cols: ["Low", "High"],
    },
  ],
});

/** The seven-types form as attached to a task: a new draft by default. */
export function taskForm(change: Partial<TaskForm> = {}): TaskForm {
  return {
    id: "form-1",
    template: sevenTypesTemplate,
    answers: null,
    status: "draft",
    rowVersion: 0,
    submittedAt: null,
    ...change,
  };
}
