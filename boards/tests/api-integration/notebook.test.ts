import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { encodeEmbedding } from "../../apps/api/src/notebook/embed/embedding-codec";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { SEARCH_BODY_BYTES } from "../../apps/api/src/notebook/routes/schema";
import { notebookChunkTable } from "../../apps/api/src/database/notebook-schema";
import {
  clearVectorCacheForTests,
  loadVectorIndex,
} from "../../apps/api/src/notebook/search/vector-index";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";
import { createForest } from "./helpers/forest";

// Synthetic corpus only: two sections that share no words, so the keyword
// list and the vector list can be told apart.
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

type Item = { kind: "query" | "chunk"; id: string; text: string };

async function notebookFixture() {
  const forest = await createForest();
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  return {
    ...forest,
    owner: (method: string, rest: string, body?: unknown) =>
      forest.ownerApi(method, path(rest), body),
    worker: (method: string, rest: string, body?: unknown) =>
      forest.agentApi(method, path(rest), body),
  };
}

const vectorFor = (text: string) =>
  encodeEmbedding(text.includes("Рубка") ? [0, 1] : [1, 0]).toString("base64");

describe("API integration: notebook", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearVectorCacheForTests();
  });
  afterEach(resetEmbedQueueForTests);

  it("stores a source once, chunks it by headings and lists its sha", async () => {
    const nb = await notebookFixture();
    const source = {
      kind: "repo-doc",
      ref: "docs/forest.md",
      title: "Лес",
      text: LEASE_DOC,
    };

    const first = await nb.owner("PUT", "/sources", source);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, chunks: 2 });
    const again = await nb.owner("PUT", "/sources", {
      ...source,
      title: "Лес v2",
    });
    expect(again.body).toMatchObject({ changed: false, chunks: 2 });

    const list = await nb.owner("GET", "/sources");
    expect(list.status).toBe(200);
    expect(list.body.model).toBe("nomic-embed-text");
    expect(list.body.sources).toEqual([
      expect.objectContaining({
        ref: "docs/forest.md",
        title: "Лес v2",
        chunks: 2,
        embedded: 0,
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("finds words by their Russian and English stems without the worker", async () => {
    const nb = await notebookFixture();
    await nb.owner("PUT", "/sources", {
      kind: "repo-doc",
      ref: "docs/forest.md",
      title: "Лес",
      text: LEASE_DOC,
    });

    const russian = await nb.owner("POST", "/search", { query: "аренды" });
    expect(russian.status).toBe(200);
    expect(russian.body.mode).toBe("keyword");
    expect(russian.body.results).toHaveLength(1);
    expect(russian.body.results[0]).toMatchObject({
      heading: "Лес › Аренда",
      source: { kind: "repo-doc", ref: "docs/forest.md", title: "Лес" },
      matchedBy: ["keyword"],
    });

    const english = await nb.owner("POST", "/search", { query: "tokens" });
    expect(
      english.body.results.map((r: { heading: string }) => r.heading),
    ).toEqual(["Лес › Аренда"]);

    // The size bound runs before the JSON is parsed.
    const padded = await nb.owner("POST", "/search", {
      query: "аренда",
      padding: "x".repeat(SEARCH_BODY_BYTES),
    });
    expect(padded.status).toBe(413);
  });

  // TB-76: past the byte budget the index keeps the freshest chunks, not
  // whatever order the heap returns.
  it("keeps the freshest chunks when the vector index is over its budget", async () => {
    const nb = await notebookFixture();
    const text = ["# Части", ""];
    for (const part of [1, 2, 3, 4])
      text.push(`## Часть ${part}`, "", `Текст ${part}.`, "");
    await nb.owner("PUT", "/sources", {
      kind: "repo-doc",
      ref: "docs/parts.md",
      title: "Части",
      text: text.join("\n"),
    });
    const chunks = await db
      .select({
        id: notebookChunkTable.id,
        ordinal: notebookChunkTable.ordinal,
      })
      .from(notebookChunkTable)
      .where(eq(notebookChunkTable.workspaceId, nb.workspace.id))
      .orderBy(notebookChunkTable.ordinal);
    expect(chunks).toHaveLength(4);
    // Embedded out of order: the second chunk is the freshest.
    const minutes = [3, 4, 1, 2];
    await Promise.all(
      chunks.map((chunk, i) =>
        db
          .update(notebookChunkTable)
          .set({
            embedModel: "nomic-embed-text",
            embedding: encodeEmbedding([1, i]),
            embeddedAt: new Date(Date.UTC(2026, 10, 13, 12, minutes[i])),
          })
          .where(eq(notebookChunkTable.id, chunk.id)),
      ),
    );

    // Two dims are 8 bytes: a 16-byte budget holds two rows of four.
    const index = await loadVectorIndex(
      nb.workspace.id,
      "nomic-embed-text",
      16,
    );
    expect(index?.ids).toEqual([chunks[1]?.id, chunks[0]?.id]);
    const status = await nb.owner("GET", "/status");
    expect(status.body).toMatchObject({ embedded: 4, searchable: 4 });
  });

  it("embeds chunks through the worker and ranks a query by meaning", async () => {
    const nb = await notebookFixture();
    await nb.owner("PUT", "/sources", {
      kind: "repo-doc",
      ref: "docs/forest.md",
      title: "Лес",
      text: LEASE_DOC,
    });

    const work = await nb.worker("GET", "/embed/work?wait=0");
    expect(work.status).toBe(200);
    const chunks: Item[] = work.body.items;
    expect(chunks.map((item) => item.kind)).toEqual(["chunk", "chunk"]);
    expect(chunks[0]?.text.startsWith("Лес › Аренда\n\n")).toBe(true);
    // Leased: a second poll does not hand the same chunks out again.
    expect((await nb.worker("GET", "/embed/work?wait=0")).body.items).toEqual(
      [],
    );

    const saved = await nb.worker("POST", "/embed/results", {
      model: "nomic-embed-text",
      items: chunks.map((item) => ({
        kind: item.kind,
        id: item.id,
        embedding: vectorFor(item.text),
      })),
    });
    expect(saved.body).toEqual({ saved: 2, rejected: 0 });
    const status = await nb.owner("GET", "/status");
    expect(status.body).toMatchObject({
      sources: 1,
      chunks: 2,
      embedded: 2,
      searchable: 2,
      workerOnline: true,
    });

    // No shared words with either section: only the vector can find it.
    const search = nb.owner("POST", "/search", {
      query: "чем заканчивается история",
    });
    const poll = await nb.worker("GET", "/embed/work?wait=5");
    const [query] = poll.body.items as Item[];
    expect(query).toMatchObject({
      kind: "query",
      text: "чем заканчивается история",
    });
    await nb.worker("POST", "/embed/results", {
      model: "nomic-embed-text",
      items: [
        {
          kind: "query",
          id: query?.id,
          embedding: encodeEmbedding([0.1, 1]).toString("base64"),
        },
      ],
    });
    const result = await search;
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe("hybrid");
    expect(result.body.results[0]).toMatchObject({
      heading: "Лес › Рубка",
      matchedBy: ["vector"],
    });
  });

  it("refuses vectors from another model and skips broken ones", async () => {
    const nb = await notebookFixture();
    const wrongModel = await nb.worker("POST", "/embed/results", {
      model: "other-model",
      items: [],
    });
    expect(wrongModel.status).toBe(409);
    const broken = await nb.worker("POST", "/embed/results", {
      model: "nomic-embed-text",
      items: [
        // A chunk replaced meanwhile: skipped, not an error.
        { kind: "chunk", id: "gone", embedding: vectorFor("x") },
        { kind: "chunk", id: "ragged", embedding: "AQ==" },
      ],
    });
    expect(broken.body).toEqual({ saved: 0, rejected: 1 });
  });

  it("prunes sources the sync no longer has", async () => {
    const nb = await notebookFixture();
    for (const ref of ["docs/a.md", "docs/b.md"]) {
      await nb.owner("PUT", "/sources", {
        kind: "repo-doc",
        ref,
        title: ref,
        text: `# ${ref}\n\nтекст`,
      });
    }
    const pruned = await nb.owner("POST", "/sources/prune", {
      kind: "repo-doc",
      keep: ["docs/a.md"],
    });
    expect(pruned.body).toEqual({ deleted: 1 });
    const list = await nb.owner("GET", "/sources");
    expect(list.body.sources.map((s: { ref: string }) => s.ref)).toEqual([
      "docs/a.md",
    ]);
  });

  it("lets a member search but not write, and keeps other workspaces out", async () => {
    const nb = await notebookFixture();
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
    const { user: outsider } = await createWorkspaceMember({ role: "owner" });
    const { app } = createApp();
    const as = async (
      user: typeof member,
      method: string,
      rest: string,
      body?: unknown,
    ) => {
      mockAuthenticatedSession(user);
      const response = await app.request(
        `/api/notebook/${nb.workspace.id}${rest}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return response.status;
    };

    expect(await as(member, "POST", "/search", { query: "аренда" })).toBe(200);
    expect(await as(member, "GET", "/status")).toBe(200);
    expect(
      await as(member, "PUT", "/sources", {
        kind: "link",
        ref: "x",
        title: "x",
        text: "x",
      }),
    ).toBe(403);
    expect(await as(member, "GET", "/embed/work")).toBe(403);
    expect([403, 404]).toContain(
      await as(outsider, "POST", "/search", { query: "аренда" }),
    );
  });
});
