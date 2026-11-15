import { asc, eq } from "drizzle-orm";
import db, { schema } from "../../database";
import { toTaskForm } from "./task-form-row";

/** An empty list is the common case: the web loads its form chunk only for a non-empty one. */
export default async function getTaskForms(taskId: string) {
  const forms = schema.taskFormTable;
  const rows = await db
    .select({ form: forms, template: schema.formTemplateTable.template })
    .from(forms)
    .innerJoin(
      schema.formTemplateTable,
      eq(forms.templateId, schema.formTemplateTable.id),
    )
    .where(eq(forms.taskId, taskId))
    .orderBy(asc(forms.createdAt), asc(forms.id));
  return { forms: rows.map((row) => toTaskForm(row.form, row.template)) };
}
