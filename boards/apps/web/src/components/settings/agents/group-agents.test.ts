import { describe, expect, it } from "vite-plus/test";
import { agentState, groupAgents } from "./group-agents";

const at = "2026-11-05T08:00:00.000Z";

describe("agent groups (TB-74)", () => {
  it("lets disabled win over the archive", () => {
    expect(agentState({ disabledAt: null, archivedAt: null })).toBe("active");
    expect(agentState({ disabledAt: null, archivedAt: at })).toBe("archived");
    expect(agentState({ disabledAt: at, archivedAt: null })).toBe("disabled");
    expect(agentState({ disabledAt: at, archivedAt: at })).toBe("disabled");
  });

  it("groups agents keeping the order within each group", () => {
    const agents = [
      { id: "a1", disabledAt: null, archivedAt: null },
      { id: "r1", disabledAt: null, archivedAt: at },
      { id: "a2", disabledAt: null, archivedAt: null },
      { id: "d1", disabledAt: at, archivedAt: null },
      { id: "r2", disabledAt: null, archivedAt: at },
    ];

    const groups = groupAgents(agents);

    expect(groups.active.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(groups.archived.map((a) => a.id)).toEqual(["r1", "r2"]);
    expect(groups.disabled.map((a) => a.id)).toEqual(["d1"]);
  });
});
