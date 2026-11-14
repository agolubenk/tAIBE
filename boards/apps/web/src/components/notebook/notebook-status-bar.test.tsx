import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotebookStatusBar } from "./notebook-status-bar";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

const state = vi.hoisted(() => ({ embedded: 0, indexed: 0 }));

vi.mock("@/hooks/queries/notebook/use-notebook-status", () => ({
  default: () => ({
    isLoading: false,
    data: {
      workerOnline: true,
      sources: 3,
      chunks: state.embedded,
      embedded: state.embedded,
      indexed: state.indexed,
      llm: { configured: false, model: null, callsToday: 0, dailyMax: null },
    },
  }),
}));

const capped = () => screen.queryByText(/notebook\.status\.indexCapped/);

describe("NotebookStatusBar", () => {
  it("says nothing about the index while every vector fits", () => {
    state.embedded = 9028;
    state.indexed = 9028;
    render(<NotebookStatusBar workspaceId="w1" />);
    expect(capped()).toBeNull();
  });

  it("warns how many chunks meaning search holds once the index is full (TB-76)", () => {
    state.embedded = 12_000;
    state.indexed = 10_922;
    render(<NotebookStatusBar workspaceId="w1" />);
    expect(capped()?.textContent).toBe(
      'workspace:notebook.status.indexCapped {"indexed":10922,"embedded":12000}',
    );
  });
});
