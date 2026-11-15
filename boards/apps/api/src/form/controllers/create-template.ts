import type { FormTemplate } from "@kaneo/forms";
import db, { schema } from "../../database";
import { ApiError } from "../../errors/api-error";

/** The template is checked by formTemplateSchema in the route. */
export default async function createTemplate(
  workspaceId: string,
  template: FormTemplate,
  actorId: string,
) {
  const table = schema.formTemplateTable;
  const [row] = await db
    .insert(table)
    .values({
      workspaceId,
      slug: template.form,
      version: template.version,
      title: template.title,
      template,
      createdBy: actorId,
    })
    .onConflictDoNothing({
      target: [table.workspaceId, table.slug, table.version],
    })
    .returning({
      id: table.id,
      slug: table.slug,
      version: table.version,
      title: table.title,
      createdAt: table.createdAt,
    });
  if (!row) {
    throw new ApiError(409, {
      message: `Template ${template.form} version ${template.version} exists: a template does not change, send the next version.`,
      code: "TEMPLATE_VERSION_EXISTS",
    });
  }
  return row;
}
