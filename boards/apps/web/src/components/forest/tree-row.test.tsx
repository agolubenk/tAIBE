import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForestTree } from "./forest-types";
import { TreeRow } from "./tree-row";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key} ${String(options.name)}` : key,
  }),
}));

vi.mock("@/lib/format", () => ({
  formatDateTime: (value: string) => value,
  formatRelativeTime: (value: string) => value,
}));

vi.mock("@/lib/i18n/domain", () => ({
  getStatusLabel: (status: string) => `label:${status}`,
}));

vi.mock("./forest-task-link", () => ({
  ForestTaskLink: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("./tree-branches", () => ({ TreeBranches: () => null }));
vi.mock("./fell-dialog", () => ({ FellDialog: () => null }));

const SECTOR =
  "Очень длинное имя сектора, которое не влезает в строку на 390 px";

function tree(status: string) {
  return {
    id: "task-1",
    projectId: "project-1",
    projectName: "tAIBE",
    number: 7,
    title: "Root task",
    status,
    isCompleted: false,
    branchCount: 0,
    lease: null,
    sectorIds: ["sector-1"],
  } as unknown as ForestTree;
}

describe("TreeRow (TB-220, TB-222)", () => {
  it("shows the status label, not the raw column slug", () => {
    render(
      <ul>
        <TreeRow
          workspaceId="workspace-1"
          tree={tree("in-progress")}
          sectorNames={new Map([["sector-1", SECTOR]])}
        />
      </ul>,
    );

    expect(screen.getByText("label:in-progress")).toBeTruthy();
    expect(screen.queryByText("in-progress")).toBeNull();
  });

  it("keeps the full sector name in the title of the truncated chip", () => {
    render(
      <ul>
        <TreeRow
          workspaceId="workspace-1"
          tree={tree("to-do")}
          sectorNames={new Map([["sector-1", SECTOR]])}
        />
      </ul>,
    );

    const chip = screen.getByText(`workspace:forest.trees.sector ${SECTOR}`);
    expect(chip).toHaveAttribute(
      "title",
      `workspace:forest.trees.sector ${SECTOR}`,
    );
    expect(chip).toHaveClass("truncate");
  });
});
