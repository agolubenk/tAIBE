type AgentStates = { disabledAt: string | null; archivedAt: string | null };

export type AgentState = "active" | "archived" | "disabled";

// Disabled is the owner's switch and wins; an archived agent comes back by
// itself when its session asks for a key again (TB-74).
export function agentState(agent: AgentStates): AgentState {
  if (agent.disabledAt) return "disabled";
  return agent.archivedAt ? "archived" : "active";
}

// Keeps the order the API sends within each group.
export function groupAgents<T extends AgentStates>(agents: T[]) {
  const groups: Record<AgentState, T[]> = {
    active: [],
    archived: [],
    disabled: [],
  };
  for (const agent of agents) groups[agentState(agent)].push(agent);
  return groups;
}
