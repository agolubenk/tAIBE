import type {
  CachedClaudeMemReader,
  CachedResult,
  Observation,
  Page,
} from "@kaneo/claude-mem-reader";
import { describe, expect, it } from "vite-plus/test";
import { findCardMemory, MEMORY_PAGE_SIZE } from "./find-card-memory";

function observation(id: number, title: string): Observation {
  return {
    id,
    memorySessionId: "s-1",
    project: "t-boards",
    platformSource: "claude",
    type: "change",
    title,
    subtitle: null,
    narrative: null,
    text: null,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: 1,
    createdAt: "2026-10-28T10:00:00.000Z",
    createdAtEpoch: 1,
  };
}

type Answer = CachedResult<Page<Observation>> | Error;

function fakeReader(pages: Answer[]) {
  const offsets: number[] = [];
  const unused = () => Promise.reject(new Error("not used"));
  const reader: CachedClaudeMemReader = {
    health: unused,
    listProjects: unused,
    getObservation: unused,
    listObservations: async (params = {}) => {
      offsets.push(params.offset ?? 0);
      const answer = pages[offsets.length - 1];
      if (!answer || answer instanceof Error) throw answer ?? new Error("none");
      return answer;
    },
  };
  return { reader, offsets };
}

function page(
  items: Observation[],
  hasMore: boolean,
  stale = false,
  fetchedAt = 1_000,
): CachedResult<Page<Observation>> {
  return {
    data: { items, hasMore, offset: 0, limit: MEMORY_PAGE_SIZE },
    stale,
    fetchedAt,
  };
}

const BINDING = {
  cardId: "task-1",
  branch: "feat/k-5",
  identifiers: ["B-12", "bugs-7"],
};

describe("findCardMemory", () => {
  it("keeps observations naming the card and says why", async () => {
    const { reader, offsets } = fakeReader([
      page(
        [
          observation(1, "Fixed B-12 on staging"),
          observation(2, "Unrelated: B-120"),
          observation(3, "pushed feat/k-5"),
        ],
        true,
      ),
      page([observation(4, "BUGS-7 reviewed")], false, true, 500),
    ]);

    const memory = await findCardMemory(reader, BINDING);

    expect(offsets).toEqual([0, MEMORY_PAGE_SIZE]);
    expect(memory).toMatchObject({
      available: true,
      stale: true,
      fetchedAt: new Date(500),
      scanned: 4,
    });
    expect(
      memory.items.map(({ id, matchedOn, matchedValue }) => ({
        id,
        matchedOn,
        matchedValue,
      })),
    ).toEqual([
      { id: 1, matchedOn: "task-id", matchedValue: "B-12" },
      { id: 3, matchedOn: "branch", matchedValue: "feat/k-5" },
      { id: 4, matchedOn: "task-id", matchedValue: "bugs-7" },
    ]);
  });

  it("answers unavailable when the worker is down and nothing is cached", async () => {
    const { reader } = fakeReader([new Error("ECONNREFUSED")]);
    expect(await findCardMemory(reader, BINDING)).toEqual({
      available: false,
      stale: false,
      fetchedAt: null,
      scanned: 0,
      items: [],
    });
  });

  it("keeps the first page when a later one fails", async () => {
    const { reader } = fakeReader([
      page([observation(1, "task-1 started")], true),
      new Error("timeout"),
    ]);
    const memory = await findCardMemory(reader, BINDING);
    expect(memory.available).toBe(true);
    expect(memory.items.map(({ id }) => id)).toEqual([1]);
  });
});
