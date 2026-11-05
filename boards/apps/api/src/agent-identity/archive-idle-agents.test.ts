import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { archiveIdleAgents } from "./archive-idle-agents";
import { type FakeDbState, type FakeQuery, fakeSchema, step } from "./fake-db";

const m = vi.hoisted(() => ({
  state: { respond: () => undefined, queries: [] } as FakeDbState,
  idle: [] as string[],
  revoke: vi.fn(async (_userId: string) => {}),
}));

vi.mock("../database", async () => {
  const { createFakeDb, fakeSchema } = await import("./fake-db");
  return { default: createFakeDb(m.state), schema: fakeSchema };
});
vi.mock("../ws", () => ({ revokeUserConnections: m.revoke }));

function respond(query: FakeQuery) {
  if (query.op === "select" && query.table === fakeSchema.agentProfileTable) {
    return m.idle.map((userId) => ({ userId }));
  }
  return undefined;
}

// Which agents count as idle is SQL, proven on PostgreSQL by the API
// integration tests; here: what happens to the ones it finds.
describe("archiveIdleAgents (TB-74)", () => {
  beforeEach(() => {
    m.state.queries.length = 0;
    m.state.respond = respond;
    m.revoke.mockClear();
  });

  it("archives the idle agents it finds, drops their keys and sessions, then cuts their sockets", async () => {
    m.idle = ["agent-1", "agent-2"];
    const now = new Date("2026-11-05T12:00:00.000Z");

    expect(await archiveIdleAgents(now)).toEqual({ archived: 2 });

    // The key subquery of the idle check is built, not run, so it is left out.
    const [select, update, ...deletes] = m.state.queries.filter(
      (q) => !(q.op === "select" && q.table === fakeSchema.apikeyTable),
    );
    expect(step(select as FakeQuery, "limit")).toEqual([200]);
    expect(step(select as FakeQuery, "for")).toEqual([
      "update",
      { skipLocked: true },
    ]);
    expect(update?.table).toBe(fakeSchema.agentProfileTable);
    expect(step(update as FakeQuery, "set")).toEqual([{ archivedAt: now }]);
    expect(deletes.map((q) => q.table)).toEqual([
      fakeSchema.apikeyTable,
      fakeSchema.sessionTable,
    ]);
    expect(m.revoke.mock.calls).toEqual([["agent-1"], ["agent-2"]]);
  });

  it("writes nothing when no agent is idle", async () => {
    m.idle = [];

    expect(await archiveIdleAgents()).toEqual({ archived: 0 });
    expect(m.state.queries.filter((q) => q.op !== "select")).toEqual([]);
    expect(m.revoke).not.toHaveBeenCalled();
  });
});
