import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AGENT_CAP_MESSAGE, MAX_AGENTS_PER_OWNER } from "./agent-limits";
import type { FakeDbState, FakeQuery } from "./fake-db.test-helper";
import { issueAgentKey } from "./issue-agent-key";

type Agent = { disabledAt: Date | null; archivedAt: Date | null };

const m = vi.hoisted(() => ({
  state: {
    respond: () => undefined,
    queries: [],
  } as FakeDbState,
  db: null as unknown,
  agent: { disabledAt: null, archivedAt: null } as Agent,
  active: 0,
  synced: vi.fn(),
}));

vi.mock("../database", async () => {
  const { createFakeDb, fakeSchema } = await import("./fake-db.test-helper");
  m.db = createFakeDb(m.state);
  return { default: m.db, schema: fakeSchema };
});
vi.mock("../auth", () => ({
  auth: {
    api: {
      createApiKey: async () => ({
        id: "key-1",
        key: "secret",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    },
  },
}));
vi.mock("./sync-agent", () => ({
  syncAgent: async (
    _ownerId: string,
    _agentId: string,
    inLock?: (tx: unknown) => Promise<void>,
  ) => {
    m.synced();
    await inLock?.(m.db);
    return "synced";
  },
}));

const identity = { ownerId: "owner-1", harness: "codex", session: "review" };
const options = { permissions: null, expiresAt: null };

function respond(query: FakeQuery) {
  if (query.op !== "select") return undefined;
  if (query.fields && "isAnonymous" in query.fields) {
    return [{ isAnonymous: false }];
  }
  if (query.fields && "n" in query.fields) return [{ n: m.active }];
  if (query.fields && "role" in query.fields) {
    return [
      {
        id: "agent-1",
        role: "agent",
        name: "review · Codex",
        session: "review",
        ...m.agent,
      },
    ];
  }
  return [];
}

function profileWrites() {
  return m.state.queries
    .filter((q) => q.op === "update")
    .map((q) => q.steps.find((s) => s.name === "set")?.args[0]);
}

describe("issueAgentKey and the archive (TB-74)", () => {
  beforeEach(() => {
    m.state.queries.length = 0;
    m.state.respond = respond;
    m.agent = { disabledAt: null, archivedAt: null };
    m.active = 0;
    m.synced.mockReset();
  });

  it("brings an archived agent back when a place is free", async () => {
    m.agent = { disabledAt: null, archivedAt: new Date() };
    m.active = MAX_AGENTS_PER_OWNER - 1;

    const issued = await issueAgentKey(identity, options);

    expect(issued.agent.id).toBe("agent-1");
    expect(m.synced).toHaveBeenCalledOnce();
    expect(profileWrites()).toEqual([
      { lastIssuedAt: expect.any(Date), archivedAt: null },
    ]);
  });

  it("refuses an archived agent with the cap message when no place is free", async () => {
    m.agent = { disabledAt: null, archivedAt: new Date() };
    m.active = MAX_AGENTS_PER_OWNER;

    await expect(issueAgentKey(identity, options)).rejects.toThrow(
      AGENT_CAP_MESSAGE,
    );
    expect(m.synced).not.toHaveBeenCalled();
    expect(profileWrites()).toEqual([]);
  });

  it("refuses a disabled agent before the cap and never takes it out of the archive", async () => {
    m.agent = { disabledAt: new Date(), archivedAt: new Date() };

    await expect(issueAgentKey(identity, options)).rejects.toThrow(
      "disabled by its owner",
    );
    expect(m.synced).not.toHaveBeenCalled();
    expect(profileWrites()).toEqual([]);
    expect(m.state.queries.some((q) => q.fields && "n" in q.fields)).toBe(
      false,
    );
  });

  it("keeps an active agent working whatever the count", async () => {
    m.active = MAX_AGENTS_PER_OWNER;

    await issueAgentKey(identity, options);

    expect(m.synced).toHaveBeenCalledOnce();
    expect(m.state.queries.some((q) => q.fields && "n" in q.fields)).toBe(
      false,
    );
  });
});
