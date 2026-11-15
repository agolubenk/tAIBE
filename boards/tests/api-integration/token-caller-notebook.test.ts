import { inArray } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { clearVectorCacheForTests } from "../../apps/api/src/notebook/search/vector-index";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

// Fake secrets assembled at runtime, so this file holds no key-shaped literal.
const join = (...parts: string[]) => parts.join("");
const SECRET = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const PART = SECRET.slice(0, 12);
const MARKER = "[REDACTED:";

// Synthetic corpus only: the secret sits in one section, the other has none.
const KEYS_DOC = [
  "# Ключи",
  "",
  "## Ротация",
  "",
  `Ротация ключа ${SECRET} раз в квартал.`,
  "",
  "## Аренда",
  "",
  "Аренда карточки истекает через час.",
].join("\n");

const text = (body: unknown) => JSON.stringify(body);

async function notebookFixture() {
  const forest = await createForest();
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  const nb = {
    ...forest,
    owner: (method: string, rest: string, body?: unknown) =>
      forest.ownerApi(method, path(rest), body),
    agent: (method: string, rest: string, body?: unknown) =>
      forest.agentApi(method, path(rest), body),
  };
  const stored = await nb.owner("PUT", "/sources", {
    kind: "repo-doc",
    ref: "docs/keys.md",
    title: `Ключи ${SECRET}`,
    text: KEYS_DOC,
  });
  expect(stored.status).toBe(200);
  return nb;
}

describe("API integration: logs and notebook for callers with a token (TB-196)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearVectorCacheForTests();
    vi.stubEnv("NOTEBOOK_LLM_MODEL", "");
    vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmbedQueueForTests();
  });

  it("masks logs for an API key and finds them only by visible text", async () => {
    const forest = await createForest();
    const root = await addTask(forest.project.id, `Rotate ${SECRET}`);
    const child = await addTask(forest.project.id, "Rotate / child");
    if (!root || !child) throw new Error("fixture");
    await relate(root.id, child.id);
    await db
      .update(schema.taskTable)
      .set({ status: "done" })
      .where(inArray(schema.taskTable.id, [root.id, child.id]));
    const felled = await forest.owner("/fell", {
      kind: "tree",
      rootId: root.id,
      reason: "done",
    });
    expect(felled.status).toBe(200);
    const logId = felled.body.logIds[0] as string;

    // The owner's session searches and reads the stored text, as before.
    const ownerFound = await forest.owner(`/logs?q=${PART}`);
    expect(ownerFound.body.items).toHaveLength(1);
    expect(text((await forest.owner(`/logs/${logId}`)).body)).toContain(SECRET);

    // A part of the secret finds nothing for the key; a visible word does.
    const hidden = await forest.agent(`/logs?q=${PART}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body.items).toEqual([]);
    const marker = await forest.agent(`/logs?q=${encodeURIComponent(MARKER)}`);
    expect(marker.body).toEqual({ items: [], nextCursor: null });
    const visible = await forest.agent("/logs?q=rotate");
    expect(visible.body.items.map((item: { id: string }) => item.id)).toEqual([
      logId,
    ]);
    expect(text(visible.body)).not.toContain(SECRET);
    expect(text(visible.body)).toContain(MARKER);
    expect(visible.body.items[0]).not.toHaveProperty("searchText");

    const log = await forest.agent(`/logs/${logId}`);
    expect(log.status).toBe(200);
    expect(text(log.body)).not.toContain(SECRET);
    expect(text(log.body)).toContain(MARKER);
  });

  it("masks notebook search and sources for an API key", async () => {
    const nb = await notebookFixture();

    const ownerSources = await nb.owner("GET", "/sources");
    expect(text(ownerSources.body)).toContain(SECRET);
    const sources = await nb.agent("GET", "/sources");
    expect(sources.status).toBe(200);
    expect(text(sources.body)).not.toContain(SECRET);
    expect(text(sources.body)).toContain(MARKER);

    // The owner finds the chunk by the secret; the key does not.
    const ownerBySecret = await nb.owner("POST", "/search", { query: SECRET });
    expect(ownerBySecret.body.results.length).toBeGreaterThan(0);
    const bySecret = await nb.agent("POST", "/search", { query: SECRET });
    expect(bySecret.status).toBe(200);
    expect(bySecret.body.results).toEqual([]);

    // A visible word finds the chunk for the key, with the secret masked.
    const ownerByWord = await nb.owner("POST", "/search", {
      query: "ротация",
    });
    expect(text(ownerByWord.body)).toContain(SECRET);
    const byWord = await nb.agent("POST", "/search", { query: "ротация" });
    expect(byWord.status).toBe(200);
    expect(
      byWord.body.results.map((hit: { heading: string }) => hit.heading),
    ).toEqual(["Ключи › Ротация"]);
    expect(text(byWord.body)).not.toContain(SECRET);
    expect(text(byWord.body)).toContain(MARKER);

    // A chunk with no secret keeps the stemmed match.
    const stemmed = await nb.agent("POST", "/search", { query: "аренды" });
    expect(
      stemmed.body.results.map((hit: { heading: string }) => hit.heading),
    ).toEqual(["Ключи › Аренда"]);
  });

  it("hands chunks to the embedding worker masked", async () => {
    const nb = await notebookFixture();

    const work = await nb.agent("GET", "/embed/work?wait=0");
    expect(work.status).toBe(200);
    const items = work.body.items as { kind: string; text: string }[];
    expect(items.map((item) => item.kind)).toEqual(["chunk", "chunk"]);
    expect(text(items)).not.toContain(SECRET);
    expect(items.filter((item) => item.text.includes(MARKER))).toHaveLength(1);
    expect(items.some((item) => item.text.includes("Ротация ключа"))).toBe(
      true,
    );
  });

  it("masks chat threads for an API key", async () => {
    const nb = await notebookFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: `ротация ${SECRET}`,
    });
    expect(asked.status).toBe(201);
    const threadId = asked.body.thread.id as string;
    expect(
      text((await nb.owner("GET", `/threads/${threadId}`)).body),
    ).toContain(SECRET);

    const list = await nb.agent("GET", "/threads");
    expect(list.status).toBe(200);
    expect(text(list.body)).not.toContain(SECRET);
    expect(text(list.body)).toContain(MARKER);
    const read = await nb.agent("GET", `/threads/${threadId}`);
    expect(read.status).toBe(200);
    expect(text(read.body)).not.toContain(SECRET);

    const started = await nb.agent("POST", "/threads", {
      question: `аренда ${SECRET}`,
    });
    expect(started.status).toBe(201);
    expect(text(started.body)).not.toContain(SECRET);
    const followUp = await nb.agent("POST", `/threads/${threadId}/messages`, {
      question: `и ещё ${SECRET}`,
    });
    expect(followUp.status).toBe(200);
    expect(text(followUp.body)).not.toContain(SECRET);
  });
});
