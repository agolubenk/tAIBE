import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { addTask, createForest } from "./helpers/forest";

// The claude-mem worker on the Mac is replaced by a fixed page: the test is
// about what the route answers, not about the reader (its tests are in
// packages/claude-mem-reader).
const worker = vi.hoisted(() => ({
  items: [] as Array<{ id: number; title: string; subtitle: string | null }>,
}));
vi.mock("../../apps/api/src/forest/memory/memory-reader", () => {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    memoryProject: () => undefined,
    getMemoryReader: () => ({
      health: unused,
      listProjects: unused,
      getObservation: unused,
      listObservations: async () => ({
        data: {
          items: worker.items.map((item) => ({
            ...item,
            memorySessionId: "s-1",
            project: "t-boards",
            platformSource: "claude",
            type: "change",
            narrative: null,
            text: null,
            facts: [],
            concepts: [],
            filesRead: [],
            filesModified: [],
            promptNumber: 1,
            createdAt: "2026-11-15T00:00:00.000Z",
            createdAtEpoch: 1,
          })),
          hasMore: false,
          offset: 0,
          limit: 100,
        },
        stale: false,
        fetchedAt: Date.now(),
      }),
    }),
  };
});

describe("API integration: card memory (TB-192)", () => {
  beforeEach(resetTestDatabase);

  it("masks secrets in observation titles for the card UI and for an agent's key (MCP)", async () => {
    const forest = await createForest();
    const card = await addTask(forest.project.id, "Remembered card");
    if (!card) throw new Error("fixture");
    const key = `tbk_${"a1B2c3D4".repeat(4)}`;
    const github = `ghp_${"Q1w2E3r4".repeat(5)}`;
    worker.items = [
      {
        id: 1,
        title: `${card.id}: rotated ${key}`,
        subtitle: `pushed with ${github}`,
      },
      { id: 2, title: "Another card", subtitle: null },
    ];

    const path = `/cards/${card.id}/memory`;
    for (const res of [await forest.owner(path), await forest.agent(path)]) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        available: true,
        scanned: 2,
        items: [
          {
            id: 1,
            title: `${card.id}: rotated [REDACTED:api_key]`,
            subtitle: "pushed with [REDACTED:api_key]",
            matchedOn: "task-id",
            matchedValue: card.id,
          },
        ],
      });
      expect(res.body.items).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(key);
      expect(JSON.stringify(res.body)).not.toContain(github);
    }
  });
});
