import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type FakeDbState, type FakeQuery, fakeSchema, step } from "./fake-db";
import { setAgentEnabled } from "./set-agent-enabled";

type Profile = { disabledAt: Date | null; archivedAt: Date | null };

const m = vi.hoisted(() => ({
  state: { respond: () => undefined, queries: [] } as FakeDbState,
  profile: null as Profile | null,
  revoke: vi.fn(async (_userId: string) => {}),
}));

vi.mock("../database", async () => {
  const { createFakeDb, fakeSchema } = await import("./fake-db");
  return { default: createFakeDb(m.state), schema: fakeSchema };
});
vi.mock("../ws", () => ({ revokeUserConnections: m.revoke }));

function respond(query: FakeQuery) {
  if (query.op === "select") return m.profile ? [m.profile] : [];
  if (query.op === "delete" && query.table === fakeSchema.apikeyTable) {
    return [{ id: "key-1" }];
  }
  return undefined;
}

const writes = () =>
  m.state.queries
    .filter((q) => q.op === "update")
    .map((q) => step(q, "set")?.[0]);

describe("setAgentEnabled and the archive (TB-74)", () => {
  beforeEach(() => {
    m.state.queries.length = 0;
    m.state.respond = respond;
    m.revoke.mockClear();
  });

  it("moves a disabled agent to the archive, not back to work", async () => {
    m.profile = { disabledAt: new Date(), archivedAt: null };

    const result = await setAgentEnabled("owner-1", "agent-1", true);

    expect(result).toEqual({
      id: "agent-1",
      enabled: true,
      archived: true,
      revokedKeys: 0,
    });
    expect(writes()).toEqual([
      { disabledAt: null, archivedAt: expect.any(Date) },
    ]);
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("leaves an active or archived agent as it is when enabled", async () => {
    m.profile = { disabledAt: null, archivedAt: null };
    expect(await setAgentEnabled("owner-1", "agent-1", true)).toMatchObject({
      archived: false,
    });
    m.profile = { disabledAt: null, archivedAt: new Date() };
    expect(await setAgentEnabled("owner-1", "agent-1", true)).toMatchObject({
      archived: true,
    });
    expect(writes()).toEqual([]);
  });

  it("disables an archived agent: disabled wins and the archive mark goes", async () => {
    m.profile = { disabledAt: null, archivedAt: new Date() };

    const result = await setAgentEnabled("owner-1", "agent-1", false);

    expect(result).toEqual({
      id: "agent-1",
      enabled: false,
      archived: false,
      revokedKeys: 1,
    });
    expect(writes()).toEqual([
      { disabledAt: expect.any(Date), archivedAt: null },
    ]);
    const deleted = m.state.queries
      .filter((q) => q.op === "delete")
      .map((q) => q.table);
    expect(deleted).toEqual([fakeSchema.apikeyTable, fakeSchema.sessionTable]);
    expect(m.revoke).toHaveBeenCalledWith("agent-1");
  });

  it("does not find someone else's agent", async () => {
    m.profile = null;
    await expect(setAgentEnabled("owner-2", "agent-1", true)).rejects.toThrow(
      "Agent not found",
    );
    expect(writes()).toEqual([]);
  });
});
