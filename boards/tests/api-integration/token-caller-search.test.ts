import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { BOARD_DESCRIPTION_MAX_BYTES } from "../../apps/api/src/task/description-pages";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const PART = SECRET.slice(0, 12);
// Longer than a board list carries, so the board searches it separately.
const filler = "x ".repeat(BOARD_DESCRIPTION_MAX_BYTES / 2 + 16);

type Search = { results: { id: string }[]; totalCount: number };
type Matches = { ids: string[]; nextCursor: string | null };

async function setup() {
  const forest = await createForest();
  const { project } = await createProjectFixture({
    workspaceId: forest.workspace.id,
    slug: "SRC",
  });
  const insert = async (title: string, description: string, number: number) => {
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title,
        description,
        status: "to-do",
        number,
        userId: forest.ownerId,
      })
      .returning();
    if (!task) throw new Error("fixture");
    return task;
  };
  const hidden = await insert(`Rotate ${SECRET}`, "plain text", 1);
  const comment = await forest.ownerApi("POST", `/comment/${hidden.id}`, {
    content: `note ${SECRET}`,
  });
  expect(comment.status).toBe(200);
  const longHidden = await insert("Long one", `${filler} ${SECRET}`, 2);
  const longVisible = await insert("Long two", `${filler} ${PART} plain`, 3);
  const search = (call: typeof forest.agentApi, q: string) =>
    call(
      "GET",
      `/search?${new URLSearchParams({ q, workspaceId: forest.workspace.id })}`,
    );
  const matches = (call: typeof forest.agentApi, query: string) =>
    call(
      "GET",
      `/task/description-matches/${project.id}?${new URLSearchParams({ query })}`,
    );
  return { forest, hidden, longHidden, longVisible, search, matches };
}

describe("API integration: search for callers with a token (TB-191)", () => {
  beforeEach(resetTestDatabase);

  it("skips rows for an API key where the query is only inside a secret", async () => {
    const { forest, hidden, longHidden, longVisible, search } = await setup();
    const ids = (body: unknown) =>
      (body as Search).results.map((result) => result.id).sort();

    // Only the description that holds the query outside a secret is found:
    // not the title, the comment or the long description with the secret.
    const agent = await search(forest.agentApi, PART);
    expect(agent.status).toBe(200);
    expect(ids(agent.body)).toEqual([longVisible.id]);
    expect((agent.body as Search).totalCount).toBe(1);

    // The owner's session searches the stored text, as before.
    const owner = await search(forest.ownerApi, PART);
    expect(ids(owner.body)).toEqual(
      expect.arrayContaining([hidden.id, longHidden.id, longVisible.id]),
    );
  });

  it("still finds visible text for an API key, with the secret masked", async () => {
    const { forest, hidden, search } = await setup();
    const res = await search(forest.agentApi, "rotate");
    expect(res.status).toBe(200);
    const body = res.body as Search;
    expect(body.results.map((result) => result.id)).toContain(hidden.id);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("returns an empty 200 for a query with a marker", async () => {
    const { forest, search, matches } = await setup();
    const res = await search(forest.agentApi, "[REDACTED:api_key]");
    expect(res.status).toBe(200);
    expect(res.body as Search).toMatchObject({ results: [], totalCount: 0 });
    const deferred = await matches(forest.agentApi, "[REDACTED:");
    expect(deferred.status).toBe(200);
    expect(deferred.body).toEqual({ ids: [], nextCursor: null });
  });

  it("matches omitted descriptions for an API key only outside secrets", async () => {
    const { forest, longHidden, longVisible, matches } = await setup();

    const agent = await matches(forest.agentApi, PART);
    expect(agent.status).toBe(200);
    expect(agent.body as Matches).toEqual({
      ids: [longVisible.id],
      nextCursor: null,
    });

    const owner = await matches(forest.ownerApi, PART);
    expect((owner.body as Matches).ids.sort()).toEqual(
      [longHidden.id, longVisible.id].sort(),
    );
  });
});
