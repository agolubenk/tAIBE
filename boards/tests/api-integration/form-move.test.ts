import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { FORM_TEMPLATE_CONFLICT } from "../../apps/api/src/form/move-project-forms";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
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

const template = (workspaceId: string, fields = TEMPLATE.fields) => ({
  workspaceId,
  slug: TEMPLATE.form,
  version: TEMPLATE.version,
  title: TEMPLATE.title,
  template: { ...TEMPLATE, fields },
});

async function setup() {
  const owner = await createWorkspaceMember({ role: "owner" });
  const [target] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${randomUUID()}`,
      createdAt: new Date(),
      name: "Target Workspace",
      slug: `workspace-${randomUUID()}`,
    })
    .returning();
  if (!target) throw new Error("fixture");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId: target.id,
    userId: owner.user.id,
    role: "owner",
    joinedAt: new Date(),
  });
  const { project } = await createProjectFixture({
    workspaceId: owner.workspace.id,
  });
  const task = await addTask(project.id);
  if (!task) throw new Error("fixture");
  const [source] = await db
    .insert(schema.formTemplateTable)
    .values(template(owner.workspace.id))
    .returning();
  if (!source) throw new Error("fixture");
  await db
    .insert(schema.taskFormTable)
    .values({ taskId: task.id, templateId: source.id });

  mockAuthenticatedSession(owner.user);
  const { app } = createApp();
  const move = () =>
    app.request(`/api/project/${project.id}/move`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: target.id }),
    });
  const forms = async () => {
    const res = await app.request(`/api/form/task/${task.id}`);
    expect(res.status).toBe(200);
    return (await res.json()).forms as Array<{ templateId: string }>;
  };
  const templatesOf = (workspaceId: string) =>
    db
      .select()
      .from(schema.formTemplateTable)
      .where(eq(schema.formTemplateTable.workspaceId, workspaceId));
  return { owner, target, source, move, forms, templatesOf };
}

// Data lens on #358 (M1): a project move takes its forms' templates along,
// so no form points into another workspace and the old one can be deleted.
describe("API integration: forms on a project move (TB-173)", () => {
  beforeEach(resetTestDatabase);

  it("copies the template into the target, and the old workspace can go", async () => {
    const { owner, target, source, move, forms, templatesOf } = await setup();

    expect((await move()).status).toBe(200);

    const [copy, ...more] = await templatesOf(target.id);
    expect(more).toEqual([]);
    expect(copy?.template).toEqual(TEMPLATE);
    expect((await forms()).map((form) => form.templateId)).toEqual([copy?.id]);

    await db
      .delete(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, owner.workspace.id));
    expect(await templatesOf(owner.workspace.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.formTemplateTable)
        .where(eq(schema.formTemplateTable.id, source.id)),
    ).toEqual([]);
    expect((await forms()).map((form) => form.templateId)).toEqual([copy?.id]);
  });

  it("reuses an equal template of the target", async () => {
    const { target, move, forms, templatesOf } = await setup();
    const [equal] = await db
      .insert(schema.formTemplateTable)
      .values(template(target.id))
      .returning();

    expect((await move()).status).toBe(200);

    expect((await templatesOf(target.id)).map((row) => row.id)).toEqual([
      equal?.id,
    ]);
    expect((await forms()).map((form) => form.templateId)).toEqual([equal?.id]);
  });

  it("refuses the move when the target has that version with other fields", async () => {
    const { owner, target, source, move, forms } = await setup();
    await db
      .insert(schema.formTemplateTable)
      .values(template(target.id, [{ id: "ok", type: "yesno", q: "OK?" }]));

    const res = await move();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(FORM_TEMPLATE_CONFLICT);
    const [project] = await db
      .select({ workspaceId: schema.projectTable.workspaceId })
      .from(schema.projectTable);
    expect(project?.workspaceId).toBe(owner.workspace.id);
    expect((await forms()).map((form) => form.templateId)).toEqual([source.id]);
  });
});
