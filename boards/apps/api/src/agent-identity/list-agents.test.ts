import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type FakeDbState, type FakeQuery, fakeSchema } from "./fake-db";
import { listAgents } from "./list-agents";

type Row = {
  id: string;
  name: string;
  harness: string;
  session: string;
  disabledAt: Date | null;
  archivedAt: Date | null;
  lastIssuedAt: Date | null;
  createdAt: Date;
};

const m = vi.hoisted(() => ({
  state: { respond: () => undefined, queries: [] } as FakeDbState,
  kept: [] as Row[],
  archived: [] as Row[],
}));

vi.mock("../database", async () => {
  const { createFakeDb, fakeSchema } = await import("./fake-db");
  return { default: createFakeDb(m.state), schema: fakeSchema };
});

const day = new Date("2026-11-04T08:00:00.000Z");

function row(id: string, state: Partial<Row> = {}): Row {
  return {
    id,
    name: `${id} · Codex`,
    harness: "codex",
    session: id,
    disabledAt: null,
    archivedAt: null,
    lastIssuedAt: day,
    createdAt: day,
    ...state,
  };
}

// The first agent query reads the kept agents, the second the archive.
function respond(query: FakeQuery) {
  if (query.op !== "select") return undefined;
  if (query.table === fakeSchema.apikeyTable) return [];
  const agentQueries = m.state.queries.filter(
    (q) => q.table === fakeSchema.agentProfileTable,
  );
  return agentQueries.indexOf(query) === 0 ? m.kept : m.archived;
}

describe("listAgents (TB-74)", () => {
  beforeEach(() => {
    m.state.queries.length = 0;
    m.state.respond = respond;
  });

  it("lists active agents, then the archive, then the disabled ones, with archivedAt", async () => {
    m.kept = [row("active"), row("off", { disabledAt: day })];
    m.archived = [row("idle", { archivedAt: day })];

    const agents = await listAgents("owner-1");

    expect(agents.map((a) => a.id)).toEqual(["active", "idle", "off"]);
    expect(agents.map((a) => a.archivedAt)).toEqual([
      null,
      day.toISOString(),
      null,
    ]);
    expect(agents[2]?.disabledAt).toBe(day.toISOString());
  });
});
