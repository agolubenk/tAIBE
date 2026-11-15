import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { schema } from "../database";
import { ApiError } from "../errors/api-error";
import type { Tx } from "../forest/tx";

export const FORM_TEMPLATE_CONFLICT = "FORM_TEMPLATE_CONFLICT";

/**
 * TB-173 (data lens on #358, M1): a project move takes the forms of its
 * cards along, and no template crosses workspaces. Each template that the
 * project's forms use is found in the target workspace by (slug, version)
 * or copied there, and the forms then point at it. The same slug and
 * version with other content in the target is a 409: a choice answer is an
 * option index of one template version. Runs in the move transaction.
 */
export async function moveProjectForms(
  tx: Tx,
  projectId: string,
  targetWorkspaceId: string,
) {
  const templates = schema.formTemplateTable;
  const forms = schema.taskFormTable;
  const used = await tx
    .selectDistinct({
      slug: templates.slug,
      version: templates.version,
      title: templates.title,
      template: templates.template,
      createdBy: templates.createdBy,
    })
    .from(forms)
    .innerJoin(templates, eq(forms.templateId, templates.id))
    .where(
      and(
        inArray(
          forms.taskId,
          tx
            .select({ id: schema.taskTable.id })
            .from(schema.taskTable)
            .where(eq(schema.taskTable.projectId, projectId)),
        ),
        ne(templates.workspaceId, targetWorkspaceId),
      ),
    );
  if (used.length === 0) return;

  // A version is immutable, so an equal row in the target is the same
  // template; the conflict check below compares the content.
  await tx
    .insert(templates)
    .values(used.map((row) => ({ ...row, workspaceId: targetWorkspaceId })))
    .onConflictDoNothing({
      target: [templates.workspaceId, templates.slug, templates.version],
    });

  const conflict = await tx.execute<{ slug: string; version: number }>(sql`
    SELECT target.slug, target.version
    FROM ${forms} form
    JOIN ${schema.taskTable} task ON task.id = form.task_id
    JOIN ${templates} source ON source.id = form.template_id
    JOIN ${templates} target ON target.workspace_id = ${targetWorkspaceId}
      AND target.slug = source.slug AND target.version = source.version
    WHERE task.project_id = ${projectId}
      AND source.workspace_id <> ${targetWorkspaceId}
      AND target.template <> source.template
    LIMIT 1
  `);
  const [clash] = conflict.rows;
  if (clash) {
    throw new ApiError(409, {
      message: `The target workspace has form template "${clash.slug}" version ${clash.version} with other fields. Save one of them as a new version before the move.`,
      code: FORM_TEMPLATE_CONFLICT,
    });
  }

  // The unique key (task_id, template_id) holds: one source workspace has
  // one template per (slug, version), so two forms of a task never meet.
  await tx.execute(sql`
    UPDATE ${forms} AS form SET template_id = target.id
    FROM ${schema.taskTable} task, ${templates} source, ${templates} target
    WHERE task.id = form.task_id AND task.project_id = ${projectId}
      AND source.id = form.template_id
      AND source.workspace_id <> ${targetWorkspaceId}
      AND target.workspace_id = ${targetWorkspaceId}
      AND target.slug = source.slug AND target.version = source.version
  `);
}
