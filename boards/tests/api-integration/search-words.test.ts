import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetTestDatabase } from "./helpers/database";
import { createProjectFixture } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Fake secret assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const PART = SECRET.slice(0, 12);

type Search = {
  results: { id: string; relevanceScore: number }[];
  totalCount: number;
};

async function setup() {
  const forest = await createForest();
  const { project } = await createProjectFixture({
    workspaceId: forest.workspace.id,
    slug: "DEP",
  });
  const insert = async (
    number: number,
    title: string,
    description: string | null = null,
  ) => {
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
  const tasks = {
    superuser: await insert(
      150,
      "Приложение досок ходит в Postgres суперпользователем (t_boards) — права БД его не ограничивают",
    ),
    focus: await insert(65, "queue_focus: mark and unmark a card"),
    lookalike: await insert(3, "tXboards superuser"),
    split: await insert(4, "rotate the key", "after the release"),
    hidden: await insert(5, `Rotate ${SECRET}`, "before the release"),
  };
  const search = async (
    call: typeof forest.agentApi,
    q: string,
  ): Promise<Search> => {
    const response = await call(
      "GET",
      `/search?${new URLSearchParams({ q, workspaceId: forest.workspace.id, type: "tasks" })}`,
    );
    expect(response.status).toBe(200);
    return response.body as Search;
  };
  const ids = (body: Search) => body.results.map((result) => result.id);
  return { forest, tasks, search, ids };
}

describe("API integration: search by the words of a query (TB-162)", () => {
  beforeEach(resetTestDatabase);

  it("finds a card by words in any order and not next to each other", async () => {
    const { forest, tasks, search, ids } = await setup();
    for (const q of [
      "t_boards суперпользователем",
      "Postgres приложение",
      "ПРИЛОЖЕНИЕ   postgres",
    ]) {
      expect(ids(await search(forest.ownerApi, q)), q).toEqual([
        tasks.superuser.id,
      ]);
    }
    expect(ids(await search(forest.ownerApi, "queue_focus mark"))).toEqual([
      tasks.focus.id,
    ]);
    expect(ids(await search(forest.ownerApi, "postgres absent"))).toEqual([]);
  });

  it("keeps one word and the card key as before; `_` is literal now", async () => {
    const { forest, tasks, search, ids } = await setup();
    expect(ids(await search(forest.ownerApi, "Postgres"))).toEqual([
      tasks.superuser.id,
    ]);
    // Before TB-162 `_` was a LIKE wildcard here, so t_boards matched
    // tXboards; now it is a literal character, as in the visible-text check.
    expect(ids(await search(forest.ownerApi, "t_boards"))).toEqual([
      tasks.superuser.id,
    ]);
    expect(ids(await search(forest.ownerApi, "DEP-4"))[0]).toBe(tasks.split.id);
  });

  it("scores all words in the title over words split between fields", async () => {
    const { forest, tasks, search } = await setup();
    const scores = async (q: string) =>
      (await search(forest.ownerApi, q)).results.map((r) => [
        r.id,
        r.relevanceScore,
      ]);
    expect(await scores("key rotate")).toEqual([[tasks.split.id, 3]]);
    expect(await scores("release after")).toEqual([[tasks.split.id, 2]]);
    expect(await scores("rotate release")).toEqual(
      expect.arrayContaining([
        [tasks.split.id, 1],
        [tasks.hidden.id, 1],
      ]),
    );
  });

  it("counts a word for an API key only outside a secret", async () => {
    const { forest, tasks, search, ids } = await setup();
    // The owner reads the stored text: PART is in the title of `hidden`.
    expect(ids(await search(forest.ownerApi, `release ${PART}`))).toEqual([
      tasks.hidden.id,
    ]);
    // The agent reads the title masked: PART is only inside the secret.
    expect(ids(await search(forest.agentApi, `release ${PART}`))).toEqual([]);
    // Words that the agent reads are found, split between fields as well.
    expect(ids(await search(forest.agentApi, "rotate release")).sort()).toEqual(
      [tasks.split.id, tasks.hidden.id].sort(),
    );
  });
});
