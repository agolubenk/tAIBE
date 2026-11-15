import type { FormTemplate } from "@kaneo/forms";
import { eq } from "drizzle-orm";
import db, { schema } from "../../database";
import { ApiError } from "../../errors/api-error";

type TaskFormRow = typeof schema.taskFormTable.$inferSelect;

/** The form with its template, as GET /form/task/{taskId} lists it. */
export function toTaskForm(form: TaskFormRow, template: FormTemplate) {
  return {
    id: form.id,
    taskId: form.taskId,
    templateId: form.templateId,
    template,
    answers: form.answers,
    status: form.status,
    rowVersion: form.rowVersion,
    submittedAt: form.submittedAt,
  };
}

export async function loadTaskForm(id: string) {
  const [row] = await db
    .select({
      form: schema.taskFormTable,
      template: schema.formTemplateTable.template,
    })
    .from(schema.taskFormTable)
    .innerJoin(
      schema.formTemplateTable,
      eq(schema.taskFormTable.templateId, schema.formTemplateTable.id),
    )
    .where(eq(schema.taskFormTable.id, id))
    .limit(1);
  if (!row) {
    throw new ApiError(404, { message: "Form not found", code: "NOT_FOUND" });
  }
  return row;
}
