import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { clearVectorCacheForTests } from "../../apps/api/src/notebook/search/vector-index";
import { writeStoredNotebookModel } from "../../apps/api/src/notebook-model/notebook-model-store";
import { urlOrigin } from "../../apps/api/src/notebook/llm/base-url";
import { sealSecret } from "../../apps/api/src/notebook-model/secret-box";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { createInstanceAdmin } from "./helpers/admin/create-instance-admin";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";
import { projectAccessApi } from "./helpers/project-access/project-access-api";

// Synthetic corpus only, as in notebook.test.ts.
const LEASE_DOC = [
  "# Лес",
  "",
  "## Аренда",
  "",
  "Аренда карточки истекает через час, fencing token растёт.",
  "",
  "## Рубка",
  "",
  "Рубка превращает ветку в бревно и семена.",
].join("\n");
const KEY = "sk-test-notebook";

type Reply = {
  status: number;
  content?: string;
  retryAfter?: string;
  delayMs?: number;
};
type Seen = {
  authorization?: string;
  messages: { role: string; content: string }[];
};

// A stand-in for any OpenAI-compatible endpoint: answers from a script and
// records what it was asked.
let llm: Server;
let baseUrl = "";
let script: Reply[] = [];
let seen: Seen[] = [];
let keyDir = "";

beforeAll(async () => {
  llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => {
      raw += part;
    });
    req.on("end", () => {
      seen.push({
        authorization: req.headers.authorization,
        messages: JSON.parse(raw).messages,
      });
      const next = script.shift() ?? { status: 200, content: "Ответ [1]." };
      setTimeout(() => {
        res.writeHead(next.status, {
          "content-type": "application/json",
          ...(next.retryAfter ? { "retry-after": next.retryAfter } : {}),
        });
        res.end(
          JSON.stringify(
            next.status === 200
              ? { choices: [{ message: { content: next.content } }] }
              : { error: "nope" },
          ),
        );
      }, next.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  keyDir = mkdtempSync(join(tmpdir(), "notebook-llm-"));
  writeFileSync(join(keyDir, "key"), `${KEY}\n`);
});

afterAll(async () => {
  await new Promise((resolve) => llm.close(resolve));
  rmSync(keyDir, { recursive: true, force: true });
});

function useLlm(dailyMax = 50) {
  vi.stubEnv("NOTEBOOK_LLM_BASE_URL", baseUrl);
  vi.stubEnv("NOTEBOOK_LLM_MODEL", "test-model");
  vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", join(keyDir, "key"));
  vi.stubEnv("NOTEBOOK_LLM_DAILY_MAX", String(dailyMax));
}

async function chatFixture() {
  const forest = await createForest();
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  const owner = (method: string, rest: string, body?: unknown) =>
    forest.ownerApi(method, path(rest), body);
  const stored = await owner("PUT", "/sources", {
    kind: "repo-doc",
    ref: "docs/forest.md",
    title: "Лес",
    text: LEASE_DOC,
  });
  expect(stored.status).toBe(200);
  return { ...forest, owner };
}

describe("API integration: notebook chat", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearVectorCacheForTests();
    script = [];
    seen = [];
    vi.stubEnv("NOTEBOOK_LLM_MODEL", "");
    vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmbedQueueForTests();
  });

  it("answers with sources only while no model is configured", async () => {
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    expect(asked.status).toBe(201);
    expect(asked.body.thread.title).toBe("аренда карточки");
    const [question, answer] = asked.body.messages;
    expect(question).toMatchObject({
      role: "user",
      content: "аренда карточки",
      status: null,
    });
    expect(answer).toMatchObject({
      role: "assistant",
      status: "retrieval-only",
      content: "",
      model: null,
      citations: [
        {
          n: 1,
          kind: "repo-doc",
          ref: "docs/forest.md",
          title: "Лес",
          heading: "Лес › Аренда",
        },
      ],
    });
    expect(answer).not.toHaveProperty("createdBy");
    expect(seen).toHaveLength(0);
  });

  it("writes a cited answer from the sources and keeps the key out of the reply", async () => {
    useLlm();
    script = [{ status: 200, content: "  Аренда истекает через час [1].\n" }];
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    expect(asked.status).toBe(201);
    expect(asked.body.messages[1]).toMatchObject({
      status: "answered",
      content: "Аренда истекает через час [1].",
      model: "test-model",
    });
    expect(JSON.stringify(asked.body)).not.toContain(KEY);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    const prompt = seen[0]?.messages ?? [];
    expect(prompt[0]?.role).toBe("system");
    expect(prompt[0]?.content).toContain(
      "[1] Лес — Лес › Аренда (docs/forest.md)",
    );
    expect(prompt[0]?.content).not.toContain("Рубка превращает");
    expect(prompt.at(-1)).toEqual({ role: "user", content: "аренда карточки" });
  });

  it("answers with the admin's model and key over the server's file and counts the call per workspace", async () => {
    useLlm();
    vi.stubEnv(
      "SETTINGS_ENCRYPTION_KEY",
      "test-settings-encryption-key-0123456789",
    );
    await writeStoredNotebookModel(
      {
        model: "admin-model",
        key: sealSecret("sk-test-admin-key", urlOrigin(baseUrl)),
      },
      null,
    );
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    expect(asked.body.messages[1]).toMatchObject({
      status: "answered",
      model: "admin-model",
    });
    expect(seen[0]?.authorization).toBe("Bearer sk-test-admin-key");

    mockAuthenticatedSession(await createInstanceAdmin());
    const view = await projectAccessApi()("/admin/notebook-model");
    expect(await view.json()).toMatchObject({
      callsToday: 1,
      usage: [{ workspaceId: nb.workspace.id, calls: 1 }],
    });
  });

  // The model may come from the settings while the key stays in the
  // server's file: each value is read on its own.
  it("answers with the admin's model and the server's key file", async () => {
    useLlm();
    vi.stubEnv("NOTEBOOK_LLM_MODEL", "");
    await writeStoredNotebookModel({ model: "admin-model" }, null);
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    expect(asked.body.messages[1]).toMatchObject({
      status: "answered",
      model: "admin-model",
    });
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("skips the model when nothing matched", async () => {
    useLlm();
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", { question: "квазар" });
    expect(asked.body.messages[1]).toMatchObject({
      status: "retrieval-only",
      citations: [],
    });
    expect(seen).toHaveLength(0);
  });

  it("waits out a short rate limit once and gives up on a long one", async () => {
    useLlm();
    const nb = await chatFixture();

    script = [
      { status: 429, retryAfter: "0" },
      { status: 200, content: "После паузы [1]." },
    ];
    const waited = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(waited.body.messages[1]).toMatchObject({
      status: "answered",
      content: "После паузы [1].",
    });
    expect(seen).toHaveLength(2);

    seen = [];
    script = [{ status: 429, retryAfter: "3600" }];
    const limited = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(limited.body.messages[1]).toMatchObject({
      status: "rate-limited",
      content: "",
      model: "test-model",
    });
    expect(limited.body.messages[1].citations).toHaveLength(1);
    expect(seen).toHaveLength(1);

    script = [{ status: 500 }];
    const failed = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(failed.body.messages[1]).toMatchObject({
      status: "failed",
      content: "",
    });
  });

  it("stops calling the model at the daily cap", async () => {
    useLlm(1);
    const nb = await chatFixture();

    const first = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(first.body.messages[1].status).toBe("answered");
    const second = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(second.body.messages[1]).toMatchObject({
      status: "capped",
      model: null,
    });
    expect(seen).toHaveLength(1);
  });

  it("holds the daily cap when questions arrive together", async () => {
    useLlm(2);
    script = Array.from({ length: 6 }, () => ({
      status: 200,
      content: "Ответ [1].",
      delayMs: 150,
    }));
    const nb = await chatFixture();

    const asked = await Promise.all(
      Array.from({ length: 6 }, () =>
        nb.owner("POST", "/threads", { question: "аренда" }),
      ),
    );
    const statuses = asked.map((reply) => reply.body.messages[1].status);
    expect(statuses.filter((status) => status === "answered")).toHaveLength(2);
    expect(statuses.filter((status) => status === "capped")).toHaveLength(4);
    expect(seen).toHaveLength(2);

    const later = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(later.body.messages[1].status).toBe("capped");
  });

  it("keeps earlier turns in a follow-up and takes sources from the new question", async () => {
    useLlm();
    script = [
      { status: 200, content: "Через час [1]." },
      { status: 200, content: "В бревно [1]." },
    ];
    const nb = await chatFixture();

    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    const threadId = asked.body.thread.id;
    const followUp = await nb.owner("POST", `/threads/${threadId}/messages`, {
      question: "а рубка?",
    });
    expect(followUp.status).toBe(200);
    expect(followUp.body.messages[1]).toMatchObject({
      status: "answered",
      content: "В бревно [1].",
      citations: [expect.objectContaining({ heading: "Лес › Рубка" })],
    });

    const prompt = seen[1]?.messages ?? [];
    expect(prompt.slice(1)).toEqual([
      { role: "user", content: "аренда карточки" },
      { role: "assistant", content: "Через час [1]." },
      { role: "user", content: "а рубка?" },
    ]);
    expect(prompt[0]?.content).toContain("Рубка превращает");
    expect(prompt[0]?.content).not.toContain("Аренда карточки истекает");

    const thread = await nb.owner("GET", `/threads/${threadId}`);
    expect(thread.status).toBe(200);
    expect(
      thread.body.messages.map((m: { role: string; content: string }) => [
        m.role,
        m.content,
      ]),
    ).toEqual([
      ["user", "аренда карточки"],
      ["assistant", "Через час [1]."],
      ["user", "а рубка?"],
      ["assistant", "В бревно [1]."],
    ]);
    const list = await nb.owner("GET", "/threads");
    expect(list.body.threads).toEqual([
      expect.objectContaining({ id: threadId, title: "аренда карточки" }),
    ]);
  });

  it("stores a brief in the thread, counts it and keeps it out of later answers", async () => {
    useLlm();
    const brief =
      "GOAL: Extend a card lease.\nCONSTRAINTS: none stated\nACCEPTANCE: lease renewed";
    script = [
      { status: 200, content: "Через час [1]." },
      { status: 200, content: `Вот бриф:\n${brief}` },
      { status: 200, content: "В бревно [1]." },
    ];
    const nb = await chatFixture();
    const asked = await nb.owner("POST", "/threads", {
      question: "аренда карточки",
    });
    const threadId = asked.body.thread.id;

    const briefed = await nb.owner("POST", `/threads/${threadId}/brief`);
    expect(briefed.status).toBe(200);
    expect(briefed.body.thread.id).toBe(threadId);
    expect(briefed.body.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        status: "brief",
        content: brief,
        model: "test-model",
        citations: [],
      }),
    ]);
    const prompt = seen[1]?.messages ?? [];
    expect(prompt[0]?.content).toContain("GOAL: <one sentence>");
    expect(prompt[1]?.content).toMatch(
      /^<<<ИСТОЧНИКИ-[0-9a-f]{12}\nQ: аренда карточки\n\nA: Через час \[1\]\./,
    );
    expect(JSON.stringify(prompt)).not.toContain(KEY);

    const status = await nb.owner("GET", "/status");
    expect(status.body.llm.callsToday).toBe(2);

    await nb.owner("POST", `/threads/${threadId}/messages`, {
      question: "а рубка?",
    });
    expect(seen[2]?.messages.slice(1)).toEqual([
      { role: "user", content: "аренда карточки" },
      { role: "assistant", content: "Через час [1]." },
      { role: "user", content: "а рубка?" },
    ]);

    const thread = await nb.owner("GET", `/threads/${threadId}`);
    expect(
      thread.body.messages.map((m: { status: string | null }) => m.status),
    ).toEqual([null, "answered", "brief", null, "answered"]);
  });

  it("stores a reply out of format as brief-failed and still counts it", async () => {
    useLlm();
    script = [
      { status: 200, content: "Через час [1]." },
      { status: 200, content: "Аренда истекает через час." },
      { status: 500 },
    ];
    const nb = await chatFixture();
    const asked = await nb.owner("POST", "/threads", { question: "аренда" });
    const threadId = asked.body.thread.id;

    const unformatted = await nb.owner("POST", `/threads/${threadId}/brief`);
    expect(unformatted.status).toBe(200);
    expect(unformatted.body.messages[0]).toMatchObject({
      status: "brief-failed",
      content: "",
      model: "test-model",
    });
    const failed = await nb.owner("POST", `/threads/${threadId}/brief`);
    expect(failed.body.messages[0]).toMatchObject({ status: "brief-failed" });

    const status = await nb.owner("GET", "/status");
    expect(status.body.llm.callsToday).toBe(3);
    expect(
      await db.$count(
        schema.notebookMessageTable,
        eq(schema.notebookMessageTable.status, "brief"),
      ),
    ).toBe(0);
  });

  it("refuses a brief at the daily cap without calling the model", async () => {
    useLlm(1);
    const nb = await chatFixture();
    const asked = await nb.owner("POST", "/threads", { question: "аренда" });
    expect(asked.body.messages[1].status).toBe("answered");

    const capped = await nb.owner(
      "POST",
      `/threads/${asked.body.thread.id}/brief`,
    );
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ code: "NOTEBOOK_DAILY_LIMIT" });
    expect(seen).toHaveLength(1);
    expect(await db.$count(schema.notebookMessageTable)).toBe(2);
  });

  it("refuses a brief without a model with a 409, not a 500", async () => {
    const nb = await chatFixture();
    const asked = await nb.owner("POST", "/threads", { question: "аренда" });

    const refused = await nb.owner(
      "POST",
      `/threads/${asked.body.thread.id}/brief`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "NOTEBOOK_MODEL_NOT_CONFIGURED",
    });
    expect(typeof refused.body.message).toBe("string");
    expect(seen).toHaveLength(0);
    const status = await nb.owner("GET", "/status");
    expect(status.body.llm.configured).toBe(false);
  });

  it("lets members ask and read, leaves deleting to managers and keeps other workspaces out", async () => {
    const nb = await chatFixture();
    const [member] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Member",
      })
      .returning();
    if (!member) throw new Error("fixture");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: nb.workspace.id,
      userId: member.id,
      role: "member",
      joinedAt: new Date(),
    });
    const other = await createWorkspaceMember({ role: "owner" });
    const { app } = createApp();
    const as = async (
      user: typeof member,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      mockAuthenticatedSession(user);
      const response = await app.request(`/api/notebook${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return response.status;
    };
    const ws = `/${nb.workspace.id}`;

    const asked = await nb.owner("POST", "/threads", { question: "аренда" });
    const thread = `${ws}/threads/${asked.body.thread.id}`;
    expect(
      await as(member, "POST", `${ws}/threads`, { question: "рубка" }),
    ).toBe(201);
    expect(
      await as(member, "POST", `${thread}/messages`, { question: "рубка" }),
    ).toBe(200);
    expect(await as(member, "GET", thread)).toBe(200);
    // Past the permission check: no model is connected here.
    expect(await as(member, "POST", `${thread}/brief`)).toBe(409);
    expect(await as(member, "DELETE", thread)).toBe(403);

    expect([403, 404]).toContain(await as(other.user, "GET", thread));
    expect([403, 404]).toContain(
      await as(other.user, "POST", `${thread}/brief`),
    );
    expect([403, 404]).toContain(
      await as(other.user, "POST", `${ws}/threads`, { question: "аренда" }),
    );
    // A thread id from this workspace under the outsider's own workspace.
    const foreign = `/${other.workspace.id}/threads/${asked.body.thread.id}`;
    expect(await as(other.user, "GET", foreign)).toBe(404);
    expect(
      await as(other.user, "POST", `${foreign}/messages`, {
        question: "аренда",
      }),
    ).toBe(404);
    // The thread is looked up in the outsider's workspace before the model.
    expect(await as(other.user, "POST", `${foreign}/brief`)).toBe(404);
    expect(await as(other.user, "DELETE", foreign)).toBe(404);

    expect(
      (await nb.owner("DELETE", `/threads/${asked.body.thread.id}`)).status,
    ).toBe(204);
    expect(
      (await nb.owner("GET", `/threads/${asked.body.thread.id}`)).status,
    ).toBe(404);
    expect(await db.$count(schema.notebookMessageTable)).toBe(2);
  });
});
