import { eq, inArray } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { seedTable } from "../../apps/api/src/database/forest-schema";
import { HISTORY_CONTENT_CHARS } from "../../apps/api/src/forest/fell/build-log";
import {
  SEED_BODY_CHARS,
  SEED_TRUNCATED,
} from "../../apps/api/src/forest/fell/build-seeds";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { clearVectorCacheForTests } from "../../apps/api/src/notebook/search/vector-index";
import {
  CUT_DOC,
  DB_TAIL,
  DB_VALUE,
  filler,
  join,
  shows,
  value,
} from "./helpers/cut-secret";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest, relate } from "./helpers/forest";

// A token that redact masks only whole: 20 characters of it stay open.
const VALUE = value(36, 1);
const TOKEN = join("gh", "p_", VALUE);
const HEAD = TOKEN.slice(0, 20);
// The secret starts 20 characters before each cut.
const cutAt = (max: number) => `${filler(max - 20)}${TOKEN} хвост`;

type Forest = Awaited<ReturnType<typeof createForest>>;
type Hit = { heading: string; text: string };
type Seed = { title: string; body: string };
type Entry = { content: string | null };

async function cutDocFixture() {
  const forest = await createForest();
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  const nb = {
    owner: (method: string, rest: string, body?: unknown) =>
      forest.ownerApi(method, path(rest), body),
    agent: (method: string, rest: string, body?: unknown) =>
      forest.agentApi(method, path(rest), body),
  };
  const stored = await nb.owner("PUT", "/sources", {
    kind: "repo-doc",
    ref: "docs/cut.md",
    title: "Граница",
    text: CUT_DOC,
  });
  expect(stored.status).toBe(200);
  return nb;
}

// A root with a long comment and three branches: one with a long
// description, one with a long comment, one whose twig title runs past the
// seed body limit. Each text has the token at its cut.
async function fellCutTree(forest: Forest) {
  const add = async (title: string, description?: string) => {
    const task = await addTask(forest.project.id, title);
    if (!task) throw new Error("fixture");
    await db
      .update(schema.taskTable)
      .set({ status: "done", description })
      .where(eq(schema.taskTable.id, task.id));
    return task;
  };
  const comment = (taskId: string, content: string) =>
    db
      .insert(schema.activityTable)
      .values({ taskId, type: "comment", content });

  const root = await add("Корень");
  const described = await add("Описание", cutAt(800));
  const discussed = await add("Обсуждение");
  const grown = await add("Ветви");
  // The body of the last seed up to the twig title, as buildSeeds writes it.
  const before = "# Ветви\n\nstatus: done · priority: low\n\n## Branches\n  - ";
  const twigTitle = `${cutAt(SEED_BODY_CHARS - SEED_TRUNCATED.length - before.length)} ${filler(400)}`;
  const twig = await add(twigTitle);
  for (const branch of [described, discussed, grown]) {
    await relate(root.id, branch.id);
  }
  await relate(grown.id, twig.id);
  await comment(root.id, cutAt(HISTORY_CONTENT_CHARS));
  await comment(discussed.id, cutAt(300));

  const felled = await forest.owner("/fell", {
    kind: "tree",
    rootId: root.id,
    reason: "done",
  });
  expect(felled.status).toBe(200);
  return felled.body.logIds[0] as string;
}

describe("API integration: secrets cut by a fixed length, for callers with a token (TB-203)", () => {
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

  it("masks a secret cut by a chunk edge in search, citations and embedding work", async () => {
    const nb = await cutDocFixture();

    // The owner reads the stored chunks: the second opens with the tail.
    const owner = await nb.owner("POST", "/search", { query: "слово" });
    const ownerHits = owner.body.results as Hit[];
    expect(ownerHits.some((hit) => hit.text.startsWith(DB_TAIL))).toBe(true);
    const ownerByTail = await nb.owner("POST", "/search", { query: DB_TAIL });
    expect(ownerByTail.body.results).toHaveLength(1);

    // The key reads every chunk, with no piece of the value.
    const agent = await nb.agent("POST", "/search", { query: "слово" });
    expect(agent.status).toBe(200);
    const agentHits = agent.body.results as Hit[];
    expect(agentHits).toHaveLength(ownerHits.length);
    expect.soft(agentHits.some((hit) => shows(hit.text, DB_VALUE))).toBe(false);

    // The tail finds and cites nothing for the key, as any hidden word.
    const byTail = await nb.agent("POST", "/search", { query: DB_TAIL });
    expect.soft(byTail.body.results).toEqual([]);
    type Message = { citations?: { heading: string }[] | null };
    const cited = (body: { messages: Message[] }) =>
      body.messages.flatMap((message) =>
        (message.citations ?? []).map((citation) => citation.heading),
      );
    const ownerThread = await nb.owner("POST", "/threads", {
      question: DB_TAIL,
    });
    expect(cited(ownerThread.body)).toEqual(["Граница"]);
    const agentThread = await nb.agent("POST", "/threads", {
      question: DB_TAIL,
    });
    expect(agentThread.status).toBe(201);
    expect.soft(cited(agentThread.body)).toEqual([]);

    // The embedding worker gets every chunk masked across its edges.
    const work = await nb.agent("GET", "/embed/work?wait=0");
    expect(work.status).toBe(200);
    const items = work.body.items as { kind: string; text: string }[];
    expect(items).toHaveLength(ownerHits.length);
    expect.soft(items.some((item) => shows(item.text, DB_VALUE))).toBe(false);
  });

  it("masks a secret cut by felling in the log and in grown cards", async () => {
    const forest = await createForest();
    const logId = await fellCutTree(forest);

    // The owner reads the stored text: each cut leaves the token's head.
    const stored = (await forest.owner(`/logs/${logId}`)).body;
    const storedSeeds = stored.seeds as Seed[];
    const storedBody = (title: string) =>
      storedSeeds.find((seed) => seed.title === title)?.body ?? "";
    expect((stored.history as Entry[])[0].content?.endsWith(HEAD)).toBe(true);
    expect(storedBody("Описание")).toContain(`${HEAD}…`);
    expect(storedBody("Обсуждение")).toContain(`${HEAD}…`);
    expect(storedBody("Ветви").endsWith(`${HEAD}${SEED_TRUNCATED}`)).toBe(true);

    // The key reads the log without the cut word, and the clip marks stay.
    const log = await forest.agent(`/logs/${logId}`);
    expect(log.status).toBe(200);
    const seeds = log.body.seeds as Seed[];
    const history = log.body.history as Entry[];
    expect(seeds).toHaveLength(3);
    expect.soft(seeds.some((seed) => shows(seed.body, VALUE))).toBe(false);
    expect
      .soft(history.some((entry) => shows(entry.content ?? "", VALUE)))
      .toBe(false);
    expect(seeds.filter((seed) => seed.body.includes("…"))).toHaveLength(3);

    // A grown card drops the cut word for everyone: it is new work.
    const seedRows = await db
      .select({ id: seedTable.id })
      .from(seedTable)
      .where(eq(seedTable.logId, logId));
    const grown = await forest.owner("/grow", {
      seedIds: seedRows.map((seed) => seed.id),
      name: "Дальше",
      slug: "dalshe",
    });
    expect(grown.status).toBe(200);
    const cards = await db
      .select({ description: schema.taskTable.description })
      .from(schema.taskTable)
      .where(inArray(schema.taskTable.id, grown.body.taskIds));
    expect(cards).toHaveLength(3);
    expect
      .soft(cards.some((card) => shows(card.description ?? "", VALUE)))
      .toBe(false);
    expect(cards.every((card) => card.description?.includes("…"))).toBe(true);
  });

  // Claude lens #400 B1: the list checked the stored comment, cut at
  // HISTORY_CONTENT_CHARS, with the cut word that the log hides: a right
  // guess at the token's head found the log, a wrong one did not.
  it("answers a guess at the cut word in the log list as any other word", async () => {
    const forest = await createForest();
    const logId = await fellCutTree(forest);
    const found = async (query: string) => {
      const list = await forest.agent(`/logs?q=${encodeURIComponent(query)}`);
      expect(list.status).toBe(200);
      return (list.body.items as { id: string }[]).map((item) => item.id);
    };

    // The owner finds the log by the cut head: it is in the stored text.
    const owner = await forest.owner(`/logs?q=${HEAD}`);
    expect(owner.body.items).toHaveLength(1);

    for (const guess of [HEAD, HEAD.slice(0, 12)]) {
      expect
        .soft(await found(guess), guess.length.toString())
        .toEqual(await found(`${guess.slice(0, -1)}0`));
    }
    // A visible word of the same comment still finds it.
    expect(await found("слово")).toEqual([logId]);
  });
});
