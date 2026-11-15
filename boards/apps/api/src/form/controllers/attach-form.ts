import { and, eq } from "drizzle-orm";
import db, { schema } from "../../database";
import { ApiError } from "../../errors/api-error";
import { toTaskForm } from "./task-form-row";

/** workspaceId is the task's, set by workspaceAccess.fromTaskId. */
export default async function attachForm(
  taskId: string,
  workspaceId: string,
  templateId: string,
  actorId: string,
) {
  const templates = schema.formTemplateTable;
  const [template] = await db
    .select({ id: templates.id, template: templates.template })
    .from(templates)
    .where(
      and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId)),
    )
    .limit(1);
  if (!template) {
    throw new ApiError(404, {
      message: "Template not found in the task's workspace",
      code: "NOT_FOUND",
    });
  }
  const forms = schema.taskFormTable;
  const [form] = await db
    .insert(forms)
    .values({ taskId, templateId, attachedBy: actorId })
    .onConflictDoNothing({ target: [forms.taskId, forms.templateId] })
    .returning();
  if (!form) {
    throw new ApiError(409, {
      message: "This template is already on the task",
      code: "FORM_ALREADY_ATTACHED",
    });
  }
  return toTaskForm(form, template.template);
}
