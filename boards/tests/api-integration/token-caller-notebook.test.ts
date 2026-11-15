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
import { encodeEmbedding } from "../../apps/api/src/notebook/embed/embedding-codec";
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
const vector = (values: number[]) => encodeEmbedding(values).toString("base64");
const cursorId = (cursor: string) =>
  Buffer.from(cursor, "base64url").toString().split("|")[1];

type Forest = Awaited<ReturnType<typeof createForest>>;
type Hit = { heading: string; score: number; matchedBy: string[] };

// A finished tree of one card, felled by the owner into one log.
async function fellCard(forest: Forest, title: string) {
  const card = await addTask(forest.project.id, title);
  if (!card) throw new Error("fixture");
  await db
    .update(schema.taskTable)
    .set({ status: "done" })
    .where(inArray(schema.taskTable.id, [card.id]));
  const felled = await forest.owner("/fell", {
    kind: "tree",
    rootId: card.id,
    reason: "done",
  });
  expect(felled.status).toBe(200);
  return felled.body.logIds[0] as string;
}

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

  it("pages logs for an API key by list order, not by hidden matches", async () => {
    const forest = await createForest();
    const older = await fellCard(forest, "Rotate older");
    await fellCard(forest, `Hidden ${SECRET}`);
    await fellCard(forest, `Hidden again ${SECRET}`);
    const newer = await fellCard(forest, "Rotate newer");

    // Two logs match only inside a secret: no item, and no cursor that
    // names one of them (backend lens #388 B1).
    const hidden = await forest.agent(`/logs?q=${PART}&take=1`);
    expect(hidden.body).toEqual({ items: [], nextCursor: null });
    expect(
      (await forest.owner(`/logs?q=${PART}&take=1`)).body.nextCursor,
    ).toBeTruthy();

    // Visible matches page one by one; the cursor is the last item shown.
    const first = await forest.agent("/logs?q=rotate&take=1");
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([
      newer,
    ]);
    expect(cursorId(first.body.nextCursor)).toBe(newer);
    const second = await forest.agent(
      `/logs?q=rotate&take=1&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([
      older,
    ]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("fuses notebook ranks for an API key without hidden keyword hits", async () => {
    const nb = await notebookFixture();

    // Keyword only: the hidden chunk leaves before the ranks are fused, so
    // the visible one has the first rank's score.
    const keyword = await nb.agent("POST", "/search", {
      query: `аренда or ${SECRET}`,
    });
    expect(keyword.body.mode).toBe("keyword");
    expect(
      (keyword.body.results as Hit[]).map((hit) => [hit.heading, hit.score]),
    ).toEqual([["Ключи › Аренда", 1 / 61]]);

    // Hybrid: the chunk with the secret stays a vector hit, not a keyword one.
    const work = await nb.agent("GET", "/embed/work?wait=0");
    const chunks = work.body.items as {
      kind: string;
      id: string;
      text: string;
    }[];
    await nb.agent("POST", "/embed/results", {
      model: "nomic-embed-text",
      items: chunks.map((item) => ({
        kind: item.kind,
        id: item.id,
        embedding: vector(item.text.includes("Ротация") ? [0, 1] : [1, 0]),
      })),
    });
    const search = nb.agent("POST", "/search", { query: SECRET });
    const poll = await nb.agent("GET", "/embed/work?wait=5");
    const [query] = poll.body.items as { id: string }[];
    await nb.agent("POST", "/embed/results", {
      model: "nomic-embed-text",
      items: [{ kind: "query", id: query?.id, embedding: vector([0.1, 1]) }],
    });
    const hybrid = await search;
    expect(hybrid.body.mode).toBe("hybrid");
    expect(
      (hybrid.body.results as Hit[]).map((hit) => [hit.heading, hit.matchedBy]),
    ).toEqual([
      ["Ключи › Ротация", ["vector"]],
      ["Ключи › Аренда", ["vector"]],
    ]);
    expect((hybrid.body.results as Hit[])[0]?.score).toBe(1 / 61);
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

  it("cites a source for an API key only by visible text", async () => {
    const nb = await notebookFixture();
    type Message = { citations?: { heading: string }[] | null };
    const cited = (body: { messages: Message[] }) =>
      body.messages.flatMap((message) =>
        (message.citations ?? []).map((citation) => citation.heading),
      );

    // The owner's question finds the chunk by its secret and cites it.
    const owner = await nb.owner("POST", "/threads", { question: SECRET });
    expect(cited(owner.body)).toEqual(["Ключи › Ротация"]);

    // The same question from a key cites nothing: a citation would tell
    // that the secret holds the question, as a search hit would (TB-191).
    const started = await nb.agent("POST", "/threads", { question: SECRET });
    expect(started.status).toBe(201);
    expect(cited(started.body)).toEqual([]);
    const followUp = await nb.agent(
      "POST",
      `/threads/${started.body.thread.id}/messages`,
      { question: SECRET },
    );
    expect(followUp.status).toBe(200);
    expect(cited(followUp.body)).toEqual([]);

    // A visible word still cites the chunk for the key.
    const visible = await nb.agent("POST", "/threads", { question: "ротация" });
    expect(cited(visible.body)).toEqual(["Ключи › Ротация"]);
  });
});
