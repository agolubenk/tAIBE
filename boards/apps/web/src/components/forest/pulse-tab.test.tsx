import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  ForestApproval,
  ForestFire,
  ForestJournalEntry,
  ForestSession,
} from "./forest-types";
import { PulseTab } from "./pulse-tab";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

vi.mock("@/lib/i18n/domain", () => ({
  getSeverityLabel: (severity: string) => `label:${severity}`,
  getStatusLabel: (status: string) => `label:${status}`,
  getPriorityLabel: (priority: string) => `label:${priority}`,
}));

vi.mock("@/lib/format", () => ({
  formatDateTime: (value: string) => value,
  formatRelativeTime: () => "5 min ago",
}));

vi.mock("./forest-task-link", () => ({
  ForestTaskLink: ({ title }: { title: string }) => <a href="#card">{title}</a>,
}));

const state = vi.hoisted(() => ({
  approvals: [] as unknown[],
  sessions: [] as unknown[],
  fires: { total: 0, items: [] as unknown[] },
  denied: [] as unknown[],
}));

const loaded = (data: unknown) => ({ data, isLoading: false, isError: false });

vi.mock("@/hooks/queries/forest/use-approvals", () => ({
  default: () => loaded({ items: state.approvals, nextCursor: null }),
}));
vi.mock("@/hooks/queries/forest/use-work-state", () => ({
  default: () => loaded(state.sessions),
}));
vi.mock("@/hooks/queries/forest/use-fires", () => ({
  default: () => loaded(state.fires),
}));
vi.mock("@/hooks/queries/forest/use-journal", () => ({
  default: () => loaded({ pages: [{ items: state.denied, nextCursor: null }] }),
}));

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

function fire(overrides: Partial<ForestFire>): ForestFire {
  return {
    taskId: "t1",
    number: 1,
    title: "Падает вход",
    status: "to-do",
    priority: "low",
    kind: "bug",
    severity: "High",
    projectId: "p1",
    projectName: "HR Helper",
    createdAt: ago(48),
    hot: true,
    ...overrides,
  };
}

function denied(overrides: Partial<ForestJournalEntry>): ForestJournalEntry {
  return {
    id: "j1",
    actorKind: "agent",
    actorName: "dev",
    action: "task.delete",
    targetType: "task",
    targetId: "t1",
    outcome: "denied",
    detail: null,
    createdAt: ago(1),
    taskNumber: null,
    taskTitle: null,
    projectId: null,
    projectName: null,
    ...overrides,
  };
}

describe("PulseTab", () => {
  it("shows what waits for you, what burns and what was refused today", () => {
    state.approvals = [
      {
        id: "a1",
        action: "close_task",
        params: { status: "done" },
        requestedByName: "dev #2",
        targetType: "task",
        targetId: "t9",
        target: null,
      } as unknown as ForestApproval,
    ];
    state.sessions = [
      { actorName: "dev #1", actorKind: "agent", waiting: "ревью" },
      { actorName: "dev #3", actorKind: "agent", waiting: null },
    ] as ForestSession[];
    state.fires = {
      total: 3,
      items: [
        fire({}),
        fire({
          taskId: "t2",
          title: "Срочный релиз",
          kind: null,
          severity: null,
          priority: "urgent",
          hot: false,
        }),
      ],
    };
    state.denied = [
      denied({}),
      denied({ id: "j2", action: "fell", createdAt: ago(30) }),
    ];
    const onTabChange = vi.fn();

    render(<PulseTab workspaceId="ws" onTabChange={onTabChange} />);

    // One «да» request and one session that waits; dev #3 waits for nothing.
    expect(screen.getByText("dev #1")).toBeTruthy();
    expect(screen.queryByText("dev #3")).toBeNull();
    expect(screen.getByText(/dev #2/)).toBeTruthy();
    // Fires: the hot bug carries the flame and its severity.
    expect(screen.getByRole("link", { name: "Падает вход" })).toBeTruthy();
    expect(screen.getAllByLabelText("workspace:forest.pulse.hot")).toHaveLength(
      1,
    );
    expect(
      screen.getByText("workspace:forest.pulse.bugSeverity label:High"),
    ).toBeTruthy();
    expect(screen.getByText("workspace:forest.pulse.urgent")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // Refusals: only the last day's.
    expect(screen.getByText("task.delete")).toBeTruthy();
    expect(screen.queryByText("fell")).toBeNull();

    fireEvent.click(screen.getByText("workspace:forest.pulse.toJournal"));
    expect(onTabChange).toHaveBeenCalledWith("journal");
    fireEvent.click(screen.getByText("workspace:forest.pulse.toApprovals"));
    expect(onTabChange).toHaveBeenCalledWith("approvals");
  });

  it("says each block is quiet when nothing waits, burns or was refused", () => {
    state.approvals = [];
    state.sessions = [];
    state.fires = { total: 0, items: [] };
    state.denied = [];

    render(<PulseTab workspaceId="ws" onTabChange={vi.fn()} />);

    expect(
      screen.getByText("workspace:forest.pulse.waitingEmpty"),
    ).toBeTruthy();
    expect(screen.getByText("workspace:forest.pulse.firesEmpty")).toBeTruthy();
    expect(screen.getByText("workspace:forest.pulse.deniedEmpty")).toBeTruthy();
  });
});
