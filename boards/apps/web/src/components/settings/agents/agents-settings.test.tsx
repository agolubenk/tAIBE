import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { AgentsSettings } from "./agents-settings";

type TestAgent = {
  id: string;
  name: string;
  harness: string;
  session: string;
  disabledAt: string | null;
  archivedAt: string | null;
  lastIssuedAt: string | null;
  createdAt: string;
  keys: unknown[];
};

const m = vi.hoisted(() => ({
  agents: [] as TestAgent[],
  mutate: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/lib/format", () => ({
  formatDateTime: () => "Nov 4, 2026, 08:00",
  formatRelativeTime: () => "yesterday",
}));
vi.mock("@/hooks/queries/agent-identity/use-agents", () => ({
  default: () => ({
    data: m.agents,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/mutations/agent-identity/use-set-agent-enabled", () => ({
  default: () => ({ mutate: m.mutate, isPending: false }),
}));
vi.mock("./tool-sets-section", () => ({ ToolSetsSection: () => null }));
vi.mock("./model-section", () => ({ ModelSection: () => null }));

const day = "2026-11-04T08:00:00.000Z";

function agent(id: string, state: Partial<TestAgent> = {}): TestAgent {
  return {
    id,
    name: `${id} · Codex`,
    harness: "codex",
    session: id,
    disabledAt: null,
    archivedAt: null,
    lastIssuedAt: day,
    createdAt: day,
    keys: [],
    ...state,
  };
}

describe("AgentsSettings and the archive (TB-74)", () => {
  beforeEach(() => {
    m.mutate.mockReset();
  });
  afterEach(cleanup);

  it("lists active and disabled agents and folds the archive with its count and hint", () => {
    m.agents = [
      agent("working", { keys: [{}] }),
      agent("idle", { archivedAt: day }),
      agent("off", { disabledAt: day }),
    ];
    render(<AgentsSettings />);

    expect(screen.getByText("working · Codex")).toBeInTheDocument();
    expect(screen.getByText("off · Codex")).toBeInTheDocument();
    const trigger = screen.getByRole("button", {
      name: /settings:agentsPage\.archive\.title \{"total":1\}/,
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByText("settings:agentsPage.archive.hint"),
    ).toBeInTheDocument();
    expect(screen.queryByText("idle · Codex")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("idle · Codex")).toBeInTheDocument();
    expect(
      screen.getByText("settings:agentsPage.row.archived"),
    ).toBeInTheDocument();
  });

  it("labels the switch of a disabled agent as a move to the archive", () => {
    m.agents = [agent("working"), agent("off", { disabledAt: day })];
    render(<AgentsSettings />);

    const toArchive = screen.getByRole("switch", {
      name: /settings:agentsPage\.row\.toArchive .*off · Codex/,
    });
    expect(toArchive).not.toBeChecked();
    fireEvent.click(toArchive);
    expect(m.mutate).toHaveBeenCalledWith({ agentId: "off", enabled: true });

    const working = screen.getByRole("switch", {
      name: /settings:agentsPage\.row\.toggle .*working · Codex/,
    });
    expect(working).toBeChecked();
    fireEvent.click(working);
    expect(m.mutate).toHaveBeenLastCalledWith({
      agentId: "working",
      enabled: false,
    });
  });

  it("lets the owner disable an archived agent", () => {
    m.agents = [agent("idle", { archivedAt: day })];
    render(<AgentsSettings />);

    expect(
      screen.queryByText("settings:agentsPage.emptyTitle"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /settings:agentsPage\.archive\.title/,
      }),
    );
    const idle = screen.getByRole("switch", {
      name: /settings:agentsPage\.row\.toggle .*idle · Codex/,
    });
    expect(idle).toBeChecked();
    fireEvent.click(idle);
    expect(m.mutate).toHaveBeenCalledWith({ agentId: "idle", enabled: false });
  });

  it("shows the empty state only when there are no agents at all", () => {
    m.agents = [];
    render(<AgentsSettings />);

    expect(
      screen.getByText("settings:agentsPage.emptyTitle"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /archive\.title/ }),
    ).not.toBeInTheDocument();
  });
});
