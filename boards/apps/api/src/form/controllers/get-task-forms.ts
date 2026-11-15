import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "../../database";
import { toTaskForm } from "./task-form-row";

/**
 * An empty list is the common case: the web loads its form chunk only for a
 * non-empty one. workspaceId is the task's (workspaceAccess.fromTaskId): a
 * template of another workspace is never read (a project move takes its
 * templates along, form/move-project-forms.ts).
 */
export default async function getTaskForms(
  taskId: string,
  workspaceId: string,
) {
  const forms = schema.taskFormTable;
  const templates = schema.formTemplateTable;
  const rows = await db
    .select({ form: forms, template: templates.template })
    .from(forms)
    .innerJoin(
      templates,
      and(
        eq(forms.templateId, templates.id),
        eq(templates.workspaceId, workspaceId),
      ),
    )
    .where(eq(forms.taskId, taskId))
    .orderBy(asc(forms.createdAt), asc(forms.id));
  return { forms: rows.map((row) => toTaskForm(row.form, row.template)) };
}
