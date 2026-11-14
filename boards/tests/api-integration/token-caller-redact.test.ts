import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { DESCRIPTION_CHUNK_CHARACTERS } from "../../apps/api/src/task/description-pages";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const DB = join("postgres", "://", "app:", "s3cr3t", "@db.local:5432/app");
const KEY_MARK = "[REDACTED:api_key]";
const DB_MARK = "[REDACTED:db_url]";

const TITLE = `Deploy ${SECRET}`;
const DESCRIPTION = `token ${SECRET}\nsample ${DB}`;
const NOTE = `note ${SECRET}`;

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
      title: TITLE,
      description: DESCRIPTION,
      status: "to-do",
      number: 7,
      userId: forest.ownerId,
    })
    .returning();
  if (!task) throw new Error("fixture");
  const comment = await forest.ownerApi("POST", `/comment/${task.id}`, {
    content: NOTE,
  });
  expect(comment.status).toBe(200);
  // An agent writes a card only under its session's lease (AC-010).
  const writer = async (taskId: string) => {
    const leased = await forest.agent("/leases", { taskId }, "dev-1");
    expect(leased.status).toBe(200);
    const fence = { "x-t-boards-fence": String(leased.body.fencingToken) };
    return (method: string, path: string, body: unknown) =>
      forest.agentApi(method, path, body, fence, "dev-1");
  };
  // N-004: an agent edits the text of a card it created, not the owner's.
  const created = await forest.agentApi("POST", `/task/${project.id}`, {
    title: TITLE,
    description: DESCRIPTION,
    status: "to-do",
    priority: "low",
  });
  expect(created.status).toBe(200);
  return {
    forest,
    project,
    task,
    agentWrite: await writer(task.id),
    agentCard: created.body.id as string,
    agentCardWrite: await writer(created.body.id),
    commentId: comment.body.id as string,
  };
}

async function storedTask(id: string) {
  const [row] = await db
    .select({
      title: schema.taskTable.title,
      description: schema.taskTable.description,
    })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, id));
  return row;
}

async function storedComment(id: string) {
  const [row] = await db
    .select({ content: schema.activityTable.content })
    .from(schema.activityTable)
    .where(eq(schema.activityTable.id, id));
  return row?.content;
}

describe("API integration: free text for callers with a token (TB-143)", () => {
  beforeEach(resetTestDatabase);

  it("masks every listed read route for an API key; a browser session reads the real text", async () => {
    const { forest, project, task } = await setup();
    const ws = forest.workspace.id;
    const search = new URLSearchParams({ q: "Deploy", workspaceId: ws });
    const routes = [
      `/task/${task.id}`,
      "/task/by-ticket-id/SEC-7",
      `/task/tasks/${project.id}`,
      `/task/${task.id}/description?offset=0`,
      `/task/export/${project.id}`,
      `/task/assigned?workspaceId=${ws}`,
      `/comment/${task.id}`,
      `/activity/${task.id}`,
      `/activity/workspace/${ws}`,
      `/search?${search}`,
    ];

    for (const route of routes) {
      const res = await forest.agentApi("GET", route);
      const text = JSON.stringify(res.body);
      expect({ route, status: res.status }).toEqual({ route, status: 200 });
      expect({ route, leaks: text.includes(SECRET) }).toEqual({
        route,
        leaks: false,
      });
      expect({ route, masked: text.includes(KEY_MARK) }).toEqual({
        route,
        masked: true,
      });
    }

    const own = await forest.ownerApi("GET", `/task/${task.id}`);
    expect(own.body).toMatchObject({ title: TITLE, description: DESCRIPTION });
    const notes = await forest.ownerApi("GET", `/comment/${task.id}`);
    expect(JSON.stringify(notes.body)).toContain(NOTE);
  });

  it("masks the task an update returns to an API key", async () => {
    const { task, agentWrite } = await setup();
    const res = await agentWrite("PUT", `/task/status/${task.id}`, {
      status: "in-progress",
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.title).toBe(`Deploy ${KEY_MARK}`);
  });

  it("keeps the owner's text when a masked write-back changes only the status", async () => {
    const { forest, task, agentWrite } = await setup();
    const read = await forest.agentApi("GET", `/task/${task.id}`);
    expect(read.body.description).toBe(`token ${KEY_MARK}\nsample ${DB_MARK}`);

    const whole = await agentWrite("PUT", `/task/${task.id}`, {
      title: read.body.title,
      description: read.body.description,
      priority: read.body.priority,
      status: "in-progress",
      projectId: read.body.projectId,
      position: read.body.position ?? 0,
    });
    expect(whole.status).toBe(200);
    expect(JSON.stringify(whole.body)).not.toContain(SECRET);
    expect(await storedTask(task.id)).toEqual({
      title: TITLE,
      description: DESCRIPTION,
    });

    // N-004 still holds: an edit of the owner's text is refused.
    const edit = await agentWrite("PUT", `/task/title/${task.id}`, {
      title: `${read.body.title} (v2)`,
    });
    expect(edit.status).toBe(403);
    expect(edit.body.message).toContain("N-004");
  });

  it("restores the stored values when a write-back keeps every marker", async () => {
    const { forest, agentCard, agentCardWrite } = await setup();
    const read = await forest.agentApi("GET", `/task/${agentCard}`);
    expect(read.body.description).toBe(`token ${KEY_MARK}\nsample ${DB_MARK}`);

    const description = await agentCardWrite(
      "PUT",
      `/task/description/${agentCard}`,
      { description: `${read.body.description}\nadded by the agent` },
    );
    expect(description.status).toBe(200);
    expect(JSON.stringify(description.body)).not.toContain(SECRET);
    expect((await storedTask(agentCard))?.description).toBe(
      `${DESCRIPTION}\nadded by the agent`,
    );

    const title = await agentCardWrite("PUT", `/task/title/${agentCard}`, {
      title: `${read.body.title} (v2)`,
    });
    expect(title.status).toBe(200);
    expect((await storedTask(agentCard))?.title).toBe(`${TITLE} (v2)`);

    const whole = await agentCardWrite("PUT", `/task/${agentCard}`, {
      title: read.body.title,
      description: read.body.description,
      priority: read.body.priority,
      status: read.body.status,
      projectId: read.body.projectId,
      position: read.body.position ?? 0,
    });
    expect(whole.status).toBe(200);
    expect(JSON.stringify(whole.body)).not.toContain(SECRET);
    expect(await storedTask(agentCard)).toEqual({
      title: TITLE,
      description: DESCRIPTION,
    });
  });

  it("refuses fewer or more markers than stored values with 409 and keeps the text", async () => {
    const { agentCard, agentCardWrite } = await setup();
    const cases = [
      `token ${KEY_MARK}`,
      `token ${KEY_MARK}\nsample ${DB_MARK}\nagain ${KEY_MARK}`,
    ];
    for (const description of cases) {
      const res = await agentCardWrite(
        "PUT",
        `/task/description/${agentCard}`,
        { description },
      );
      expect(res.status).toBe(409);
      expect(res.body.message).toContain(
        "Keep the [REDACTED:…] markers in place; a person removes a secret in the web app.",
      );
    }
    const title = await agentCardWrite("PUT", `/task/title/${agentCard}`, {
      title: `${KEY_MARK} ${KEY_MARK}`,
    });
    expect(title.status).toBe(409);
    expect(await storedTask(agentCard)).toEqual({
      title: TITLE,
      description: DESCRIPTION,
    });
  });

  it("writes text without markers as before", async () => {
    const { agentCard, agentCardWrite } = await setup();
    const res = await agentCardWrite("PUT", `/task/description/${agentCard}`, {
      description: "rewritten without secrets",
    });
    expect(res.status).toBe(200);
    expect((await storedTask(agentCard))?.description).toBe(
      "rewritten without secrets",
    );
  });

  it("restores a comment on both comment routes and refuses a lost marker", async () => {
    const { forest, task, agentWrite, commentId } = await setup();
    const list = await forest.agentApi("GET", `/comment/${task.id}`);
    const masked = (list.body as { id: string; content: string }[]).find(
      (item) => item.id === commentId,
    )?.content;
    expect(masked).toBe(`note ${KEY_MARK}`);

    const edited = await agentWrite("PUT", `/comment/${commentId}`, {
      content: `${masked} edited`,
    });
    expect(edited.status).toBe(200);
    expect(JSON.stringify(edited.body)).not.toContain(SECRET);
    expect(await storedComment(commentId)).toBe(`${NOTE} edited`);

    const legacy = await agentWrite("PUT", "/activity/comment", {
      activityId: commentId,
      comment: `${masked} twice`,
    });
    expect(legacy.status).toBe(200);
    expect(await storedComment(commentId)).toBe(`${NOTE} twice`);

    const lost = await agentWrite("PUT", `/comment/${commentId}`, {
      content: `${KEY_MARK} ${KEY_MARK}`,
    });
    expect(lost.status).toBe(409);
    expect(await storedComment(commentId)).toBe(`${NOTE} twice`);
  });

  it("leaves a browser session's write as it is, markers included", async () => {
    const { forest, task } = await setup();
    const res = await forest.ownerApi("PUT", `/task/description/${task.id}`, {
      description: `the API shows ${KEY_MARK}`,
    });
    expect(res.status).toBe(200);
    expect((await storedTask(task.id))?.description).toBe(
      `the API shows ${KEY_MARK}`,
    );
  });

  it("pages the masked description, so a secret on a page edge stays hidden", async () => {
    const { forest, task } = await setup();
    // The secret starts 10 characters before the first page edge.
    const filler = "x ".repeat(40 * 1024);
    const edge = DESCRIPTION_CHUNK_CHARACTERS - 10;
    const long = `${filler.slice(0, edge - 1)} ${SECRET} ${filler}`;
    await db
      .update(schema.taskTable)
      .set({ description: long })
      .where(eq(schema.taskTable.id, task.id));

    const read = async (
      call: typeof forest.agentApi | typeof forest.ownerApi,
    ) => {
      let text = "";
      let offset: number | null = 0;
      while (offset !== null) {
        const res = await call(
          "GET",
          `/task/${task.id}/description?offset=${offset}`,
        );
        expect(res.status).toBe(200);
        const page = res.body as { content: string; nextOffset: number | null };
        text += page.content;
        offset = page.nextOffset;
      }
      return text;
    };

    const agentText = await read(forest.agentApi);
    expect(agentText).not.toContain(SECRET.slice(0, 10));
    expect(agentText).not.toContain(SECRET.slice(10));
    expect(agentText).toContain(KEY_MARK);
    expect(await read(forest.ownerApi)).toBe(long);
  });
});
