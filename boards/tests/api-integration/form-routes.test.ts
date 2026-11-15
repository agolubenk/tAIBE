import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { addTask, createForest } from "./helpers/forest";

// A fake secret assembled at runtime, so this file holds no key-shaped literal.
const SECRET = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const KEY_MARK = "[REDACTED:api_key]";

const TEMPLATE = {
  form: "demo",
  version: 1,
  title: "Demo",
  fields: [
    { id: "name", type: "input", q: "Name", kind: "text", required: true },
    { id: "agree", type: "yesno", q: "Agree?" },
  ],
};

const doc = (answers: Record<string, unknown>, version = 1) => ({
  form: "demo",
  version,
  answers,
});

async function setup() {
  const forest = await createForest();
  const task = await addTask(forest.project.id);
  if (!task) throw new Error("fixture");
  const created = await forest.ownerApi(
    "POST",
    `/form/template/${forest.workspace.id}`,
    { template: TEMPLATE },
  );
  expect(created.status).toBe(201);
  const attached = await forest.ownerApi("POST", `/form/task/${task.id}`, {
    templateId: created.body.id,
  });
  expect(attached.status).toBe(201);
  const formId = attached.body.id as string;
  const save = (body: unknown) =>
    forest.ownerApi("PUT", `/form/${formId}/answers`, body);
  return { forest, task, form: attached.body, formId, save };
}

describe("API integration: task forms (TB-173)", () => {
  beforeEach(resetTestDatabase);

  it("keeps a template version and a task's form unique", async () => {
    const { forest, task, form } = await setup();

    const again = await forest.ownerApi(
      "POST",
      `/form/template/${forest.workspace.id}`,
      { template: TEMPLATE },
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("TEMPLATE_VERSION_EXISTS");

    const twice = await forest.ownerApi("POST", `/form/task/${task.id}`, {
      templateId: form.templateId,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("FORM_ALREADY_ATTACHED");
  });

  it("does not attach a template of another workspace", async () => {
    const { forest, task } = await setup();
    const other = await createWorkspaceMember({ role: "owner" });
    const [foreign] = await db
      .insert(schema.formTemplateTable)
      .values({
        workspaceId: other.workspace.id,
        slug: "demo",
        version: 1,
        title: "Demo",
        template: TEMPLATE as never,
        createdBy: other.user.id,
      })
      .returning();

    const res = await forest.ownerApi("POST", `/form/task/${task.id}`, {
      templateId: foreign?.id,
    });
    expect(res.status).toBe(404);
  });

  it("saves a draft without required and checks required on submit", async () => {
    const { form, save } = await setup();
    expect(form).toMatchObject({ status: "draft", rowVersion: 0 });

    const draft = await save({
      answers: doc({ agree: true }),
      submit: false,
      rowVersion: 0,
    });
    expect(draft.status).toBe(200);
    expect(draft.body.saved).toMatchObject({ status: "draft", rowVersion: 1 });

    const missing = await save({
      answers: doc({ agree: true }),
      submit: true,
      rowVersion: 1,
    });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("INVALID_ANSWERS");
    expect(missing.body.answerIssues).toEqual([
      { fieldId: "name", code: "required" },
    ]);

    const stale = await save({
      answers: doc({ name: "A" }),
      submit: true,
      rowVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("ROW_VERSION_CONFLICT");

    const nextVersion = await save({
      answers: doc({ name: "A" }, 2),
      submit: true,
      rowVersion: 1,
    });
    expect(nextVersion.status).toBe(409);
    expect(nextVersion.body.code).toBe("VERSION_MISMATCH");

    const submitted = await save({
      answers: doc({ name: "A" }),
      submit: true,
      rowVersion: 1,
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.saved).toMatchObject({
      status: "submitted",
      rowVersion: 2,
    });
    expect(submitted.body.saved.submittedAt).toEqual(expect.any(String));
  });

  it("lets only a person answer; a token caller reads masked text", async () => {
    const { forest, task, formId, save } = await setup();
    const saved = await save({
      answers: doc({ name: `deploy ${SECRET}` }),
      submit: true,
      rowVersion: 0,
    });
    expect(saved.status).toBe(200);

    const byAgent = await forest.agentApi("PUT", `/form/${formId}/answers`, {
      answers: doc({ name: "B" }),
      submit: false,
      rowVersion: 1,
    });
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.code).toBe("PERSON_ONLY");

    for (const route of [`/form/task/${task.id}`, `/form/${formId}/export`]) {
      const byKey = await forest.agentApi("GET", route);
      expect(byKey.status).toBe(200);
      expect(JSON.stringify(byKey.body)).not.toContain(SECRET);
      expect(JSON.stringify(byKey.body)).toContain(KEY_MARK);
      const byOwner = await forest.ownerApi("GET", route);
      expect(JSON.stringify(byOwner.body)).toContain(SECRET);
    }
  });

  it("exports the answers in the grill format", async () => {
    const { forest, formId, save } = await setup();
    await save({
      answers: doc({ name: "A", agree: false }),
      submit: true,
      rowVersion: 0,
    });

    const res = await forest.ownerApi("GET", `/form/${formId}/export`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      form: "demo",
      version: 1,
      answered: 2,
      total: 2,
    });
  });

  it("refuses a body above the limit before it parses it", async () => {
    const { save } = await setup();
    const res = await save({
      answers: doc({ name: "x".repeat(600 * 1024) }),
      submit: false,
      rowVersion: 0,
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
