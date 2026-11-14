import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const SECRET_2 = join("gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
const MARK = "[REDACTED:api_key]";
const MISMATCH = "REDACTED_MARKERS_MISMATCH";

async function setup() {
  const forest = await createForest();
  const { project } = await createProjectFixture({
    workspaceId: forest.workspace.id,
    slug: "SEC",
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Deploy",
      description: `token ${SECRET}`,
      status: "to-do",
      number: 7,
      userId: forest.ownerId,
    })
    .returning();
  if (!task) throw new Error("fixture");
  return { forest, project, task };
}

async function addLabel(workspaceId: string, taskId: string, name: string) {
  const [label] = await db
    .insert(schema.labelTable)
    .values({ name, color: "#ffffff", taskId, workspaceId })
    .returning();
  if (!label) throw new Error("fixture");
  return label;
}

async function addField(
  projectId: string,
  values: {
    name: string;
    type: string;
    defaultValue?: string;
    options?: string[];
  },
) {
  const [field] = await db
    .insert(schema.customFieldDefinitionTable)
    .values({ projectId, required: false, position: 0, ...values })
    .returning();
  if (!field) throw new Error("fixture");
  return field;
}

async function labelName(id: string) {
  const [row] = await db
    .select({ name: schema.labelTable.name })
    .from(schema.labelTable)
    .where(eq(schema.labelTable.id, id));
  return row?.name;
}

async function storedField(id: string) {
  const [row] = await db
    .select()
    .from(schema.customFieldDefinitionTable)
    .where(eq(schema.customFieldDefinitionTable.id, id));
  return row;
}

describe("API integration: masked labels, fields and links written back (TB-144)", () => {
  beforeEach(resetTestDatabase);

  it("restores a masked label name on PUT and refuses a changed marker count", async () => {
    const { forest, task } = await setup();
    const label = await addLabel(forest.workspace.id, task.id, `env ${SECRET}`);

    const same = await forest.agentApi("PUT", `/label/${label.id}`, {
      name: `env ${MARK}`,
      color: "#000000",
    });
    expect(same.status).toBe(200);
    expect(await labelName(label.id)).toBe(`env ${SECRET}`);

    const more = await forest.agentApi("PUT", `/label/${label.id}`, {
      name: `env ${MARK} ${MARK}`,
      color: "#000000",
    });
    expect(more.status).toBe(409);
    expect(more.body.code).toBe(MISMATCH);
    expect(await labelName(label.id)).toBe(`env ${SECRET}`);

    const plain = await forest.agentApi("PUT", `/label/${label.id}`, {
      name: "env",
      color: "#000000",
    });
    expect(plain.status).toBe(200);
    expect(await labelName(label.id)).toBe("env");
  });

  it("refuses a marker in a new label name and leaves a browser session's write as it is", async () => {
    const { forest, task } = await setup();
    const created = await forest.agentApi("POST", "/label", {
      name: `env ${MARK}`,
      color: "#000000",
      workspaceId: forest.workspace.id,
      taskId: task.id,
    });
    expect(created.status).toBe(409);
    expect(created.body.code).toBe(MISMATCH);
    expect(created.body.message).toContain("PUT /label/{id}/task");
    expect(
      await db
        .select()
        .from(schema.labelTable)
        .where(eq(schema.labelTable.taskId, task.id)),
    ).toEqual([]);

    const label = await addLabel(forest.workspace.id, task.id, `env ${SECRET}`);
    const browser = await forest.ownerApi("PUT", `/label/${label.id}`, {
      name: `env ${MARK}`,
      color: "#000000",
    });
    expect(browser.status).toBe(200);
    expect(await labelName(label.id)).toBe(`env ${MARK}`);
  });

  it("restores a masked custom-field value and refuses a value with a lost marker", async () => {
    const { forest, project, task } = await setup();
    const field = await addField(project.id, { name: "Runbook", type: "text" });
    await db
      .insert(schema.customFieldValueTable)
      .values({ taskId: task.id, fieldId: field.id, value: `key ${SECRET}` });
    const stored = async () => {
      const [row] = await db
        .select({ value: schema.customFieldValueTable.value })
        .from(schema.customFieldValueTable)
        .where(eq(schema.customFieldValueTable.fieldId, field.id));
      return row?.value;
    };

    const same = await forest.agentApi("PUT", "/custom-field/value", {
      taskId: task.id,
      fieldId: field.id,
      value: `key ${MARK}`,
    });
    expect(same.status).toBe(200);
    expect(await stored()).toBe(`key ${SECRET}`);

    const lost = await forest.agentApi("PUT", "/custom-field/value", {
      taskId: task.id,
      fieldId: field.id,
      value: `key ${MARK} and ${MARK}`,
    });
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe(MISMATCH);
    expect(await stored()).toBe(`key ${SECRET}`);
  });

  it("restores a masked field name, default and options in stored order, and refuses an extra marker", async () => {
    const { forest, project } = await setup();
    const text = await addField(project.id, {
      name: `Vault ${SECRET}`,
      type: "text",
      defaultValue: `default ${SECRET_2}`,
    });
    const renamed = await forest.agentApi("PUT", `/custom-field/${text.id}`, {
      name: `Vault ${MARK}`,
      defaultValue: `default ${MARK}`,
    });
    expect(renamed.status).toBe(200);
    expect(await storedField(text.id)).toMatchObject({
      name: `Vault ${SECRET}`,
      defaultValue: `default ${SECRET_2}`,
    });

    const choice = await addField(project.id, {
      name: "Env",
      type: "dropdown",
      options: ["prod", SECRET, SECRET_2],
    });
    const options = await forest.agentApi("PUT", `/custom-field/${choice.id}`, {
      options: [MARK, "prod", MARK, "stage"],
    });
    expect(options.status).toBe(200);
    expect((await storedField(choice.id))?.options).toEqual([
      SECRET,
      "prod",
      SECRET_2,
      "stage",
    ]);

    const extra = await forest.agentApi("PUT", `/custom-field/${choice.id}`, {
      options: [MARK, MARK, MARK, "prod", "stage"],
    });
    expect(extra.status).toBe(409);
    expect(extra.body.code).toBe(MISMATCH);
    expect((await storedField(choice.id))?.options).toEqual([
      SECRET,
      "prod",
      SECRET_2,
      "stage",
    ]);
  });

  it("refuses a marker in a new link URL or title and adds a link without one", async () => {
    const { forest, task } = await setup();
    for (const body of [
      { url: `https://ci.example/run?token=${MARK}` },
      { url: "https://ci.example/run", title: `run ${MARK}` },
    ]) {
      const res = await forest.agentApi(
        "POST",
        `/external-link/task/${task.id}`,
        body,
      );
      expect({ body, status: res.status, code: res.body?.code }).toEqual({
        body,
        status: 409,
        code: MISMATCH,
      });
    }
    const plain = await forest.agentApi(
      "POST",
      `/external-link/task/${task.id}`,
      { url: "https://ci.example/run", title: "run" },
    );
    expect(plain.status).toBe(200);
    const links = await db
      .select({ url: schema.externalLinkTable.url })
      .from(schema.externalLinkTable)
      .where(eq(schema.externalLinkTable.taskId, task.id));
    expect(links).toEqual([{ url: "https://ci.example/run" }]);
  });

  it("masks card history and the context pack for an API key; the owner's session reads the real text", async () => {
    const { forest, task } = await setup();
    await db.insert(schema.cardHistoryTable).values({
      taskId: task.id,
      kind: "task",
      revision: 1,
      changes: { description: { from: `old ${SECRET}`, to: "new" } },
    });
    const note = await forest.ownerApi("POST", `/comment/${task.id}`, {
      content: `note ${SECRET_2}`,
    });
    expect(note.status).toBe(200);

    for (const path of [
      `/cards/${task.id}/history`,
      `/cards/${task.id}/context`,
    ]) {
      const agent = await forest.agent(path);
      const agentText = JSON.stringify(agent.body);
      expect({ path, status: agent.status }).toEqual({ path, status: 200 });
      expect({
        path,
        leaks: agentText.includes(SECRET) || agentText.includes(SECRET_2),
        masked: agentText.includes(MARK),
      }).toEqual({ path, leaks: false, masked: true });

      const owner = await forest.owner(path);
      expect({
        path,
        real: JSON.stringify(owner.body).includes(SECRET),
      }).toEqual({ path, real: true });
    }
  });
});

describe("API integration: label, field and link routes for callers with a token (TB-178)", () => {
  beforeEach(resetTestDatabase);

  it("masks every read route for an API key; a browser session reads the real values", async () => {
    const { forest, project, task } = await setup();
    const ws = forest.workspace.id;
    const label = await addLabel(ws, task.id, `env ${SECRET}`);
    const field = await addField(project.id, {
      name: `Vault ${SECRET}`,
      type: "text",
    });
    const value = await forest.ownerApi("PUT", "/custom-field/value", {
      taskId: task.id,
      fieldId: field.id,
      value: `key ${SECRET}`,
    });
    expect(value.status).toBe(200);
    const link = await forest.ownerApi(
      "POST",
      `/external-link/task/${task.id}`,
      { url: `https://ci.example/run?token=${SECRET}`, title: "run" },
    );
    expect(link.status).toBe(200);

    for (const route of [
      `/label/task/${task.id}`,
      `/label/workspace/${ws}`,
      `/label/${label.id}`,
      `/custom-field/project/${project.id}`,
      `/custom-field/project/${project.id}/values`,
      `/custom-field/task/${task.id}`,
      `/custom-field/project/${project.id}/filter-values`,
      `/external-link/task/${task.id}`,
    ]) {
      const agent = await forest.agentApi("GET", route);
      const text = JSON.stringify(agent.body);
      expect({ route, status: agent.status }).toEqual({ route, status: 200 });
      expect({
        route,
        leaks: text.includes(SECRET),
        masked: text.includes(MARK),
      }).toEqual({ route, leaks: false, masked: true });

      const owner = await forest.ownerApi("GET", route);
      expect({
        route,
        real: JSON.stringify(owner.body).includes(SECRET),
      }).toEqual({ route, real: true });
    }
  });

  it("masks the answer of a write that restored a value, and refuses a marker in a new field", async () => {
    const { forest, project, task } = await setup();
    const label = await addLabel(forest.workspace.id, task.id, `env ${SECRET}`);
    const updated = await forest.agentApi("PUT", `/label/${label.id}`, {
      name: `env ${MARK}`,
      color: "#000000",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe(`env ${MARK}`);
    expect(await labelName(label.id)).toBe(`env ${SECRET}`);

    for (const body of [
      { name: `Vault ${MARK}`, type: "text" },
      { name: "Env", type: "dropdown", options: ["prod", MARK] },
    ]) {
      const res = await forest.agentApi("POST", "/custom-field", {
        projectId: project.id,
        ...body,
      });
      expect({ body, status: res.status, code: res.body?.code }).toEqual({
        body,
        status: 409,
        code: MISMATCH,
      });
    }
    expect(
      await db
        .select()
        .from(schema.customFieldDefinitionTable)
        .where(eq(schema.customFieldDefinitionTable.projectId, project.id)),
    ).toEqual([]);
  });

  it("picks a masked dropdown or multiselect option by the field's options, and refuses an ambiguous pick", async () => {
    const { forest, project, task } = await setup();
    const value = async (fieldId: string) => {
      const [row] = await db
        .select({ value: schema.customFieldValueTable.value })
        .from(schema.customFieldValueTable)
        .where(eq(schema.customFieldValueTable.fieldId, fieldId));
      return row?.value;
    };
    const put = (fieldId: string, sent: string) =>
      forest.agentApi("PUT", "/custom-field/value", {
        taskId: task.id,
        fieldId,
        value: sent,
      });

    const env = await addField(project.id, {
      name: "Env",
      type: "dropdown",
      options: ["prod", SECRET],
    });
    expect((await put(env.id, MARK)).status).toBe(200);
    expect(await value(env.id)).toBe(SECRET);

    const keys = await addField(project.id, {
      name: "Keys",
      type: "multiselect",
      options: ["prod", SECRET, SECRET_2],
    });
    const owner = await forest.ownerApi("PUT", "/custom-field/value", {
      taskId: task.id,
      fieldId: keys.id,
      value: JSON.stringify(["prod", SECRET]),
    });
    expect(owner.status).toBe(200);
    expect((await put(keys.id, JSON.stringify([MARK]))).status).toBe(200);
    expect(await value(keys.id)).toBe(JSON.stringify([SECRET]));
    expect((await put(keys.id, JSON.stringify([MARK, MARK]))).status).toBe(200);
    expect(await value(keys.id)).toBe(JSON.stringify([SECRET, SECRET_2]));

    const dropOne = await put(keys.id, JSON.stringify([MARK]));
    expect(dropOne.status).toBe(409);
    expect(dropOne.body.code).toBe(MISMATCH);
    expect(await value(keys.id)).toBe(JSON.stringify([SECRET, SECRET_2]));

    // A field of another project is not found; its options are not compared.
    const { project: other } = await createProjectFixture({
      workspaceId: forest.workspace.id,
      slug: "OTH",
    });
    const foreign = await addField(other.id, {
      name: "Env",
      type: "dropdown",
      options: [SECRET, SECRET_2],
    });
    expect((await put(foreign.id, MARK)).status).toBe(404);
  });

  it("masks notifications, task relations, trees and a card's place for an API key", async () => {
    const { forest, project } = await setup();
    const [root] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: `root ${SECRET}`,
        status: "to-do",
        number: 8,
      })
      .returning();
    const [child] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "child",
        status: "to-do",
        number: 9,
      })
      .returning();
    if (!root || !child) throw new Error("fixture");
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: root.id,
      targetTaskId: child.id,
      relationType: "subtask",
    });
    await db.insert(schema.notificationTable).values({
      userId: forest.ownerId,
      title: `alert ${SECRET}`,
      content: "deploy",
    });

    const reads: [string, () => ReturnType<typeof forest.agent>][] = [
      ["/notification", () => forest.agentApi("GET", "/notification")],
      [
        "/task-relation/{child}",
        () => forest.agentApi("GET", `/task-relation/${child.id}`),
      ],
      ["/forest/trees", () => forest.agent("/trees")],
      ["/forest/place", () => forest.agent(`/cards/${child.id}/place`)],
    ];
    for (const [route, read] of reads) {
      const res = await read();
      const text = JSON.stringify(res.body);
      expect({
        route,
        status: res.status,
        leaks: text.includes(SECRET),
        masked: text.includes(MARK),
      }).toEqual({ route, status: 200, leaks: false, masked: true });
    }

    const owner = await forest.ownerApi("GET", "/notification");
    expect(JSON.stringify(owner.body)).toContain(SECRET);

    // The graph cursor is base64url; it comes back raw, so page 2 works.
    const pages: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?take=1&cursor=${encodeURIComponent(cursor)}`
        : "?take=1";
      const page = await forest.agent(`/graph${query}`);
      expect({ page: pages.length, status: page.status }).toEqual({
        page: pages.length,
        status: 200,
      });
      pages.push(page.body);
      cursor = page.body.nextCursor;
    } while (cursor && pages.length < 5);
    const graph = JSON.stringify(pages);
    expect(pages.length).toBe(3);
    expect(graph.includes(SECRET)).toBe(false);
    expect(graph).toContain(MARK);
  });
});
