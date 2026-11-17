import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { addTask } from "./helpers/forest";

const TEMPLATE = {
  form: "demo",
  version: 1,
  title: "Demo",
  fields: [{ id: "agree", type: "yesno" as const, q: "Agree?" }],
};

async function setup() {
  const { user, workspace } = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({ workspaceId: workspace.id });
  const task = await addTask(project.id);
  if (!task) throw new Error("fixture");
  const [template] = await db
    .insert(schema.formTemplateTable)
    .values({
      workspaceId: workspace.id,
      slug: TEMPLATE.form,
      version: TEMPLATE.version,
      title: TEMPLATE.title,
      template: TEMPLATE,
      createdBy: user.id,
    })
    .returning();
  if (!template) throw new Error("fixture");
  await db
    .insert(schema.taskFormTable)
    .values({ taskId: task.id, templateId: template.id, attachedBy: user.id });
  return { workspace, template };
}

// task_form.template_id is DEFERRABLE INITIALLY DEFERRED (hand-written line in
// drizzle/*_t_boards_forms.sql): a workspace delete reaches task_form by two
// cascade paths, and a plain NO ACTION key fails it inside the statement.
describe("API integration: form rows on delete (TB-173)", () => {
  beforeEach(resetTestDatabase);

  it("deletes a workspace that has a template on a task", async () => {
    const { workspace } = await setup();

    await db
      .delete(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, workspace.id));

    expect(await db.select().from(schema.taskFormTable)).toEqual([]);
    expect(await db.select().from(schema.formTemplateTable)).toEqual([]);
  });

  it("refuses to delete a template that is on a task", async () => {
    const { template } = await setup();

    await expect(
      db
        .delete(schema.formTemplateTable)
        .where(eq(schema.formTemplateTable.id, template.id)),
    ).rejects.toThrow();
    expect(await db.select().from(schema.formTemplateTable)).toHaveLength(1);
  });
});
