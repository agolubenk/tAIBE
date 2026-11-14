import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";
import { ModelUsageSection } from "./model-usage-section";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: "en-US" },
  }),
}));

const KEY = "settings:adminNotebookModel.usage";

function settings(
  usage: Partial<NotebookModelSettings["usage"][number]>[],
): NotebookModelSettings {
  return {
    callsToday: 15,
    dailyMax: 500,
    usage: usage.map((row, index) => ({
      workspaceId: `w${index}`,
      name: `Product ${index}`,
      calls: 0,
      withUsage: 0,
      input: 0,
      output: 0,
      cached: 0,
      ...row,
    })),
  } as NotebookModelSettings;
}

describe("ModelUsageSection (TB-134 tokens)", () => {
  it("shows compact token sums and the coverage next to them", () => {
    render(
      <ModelUsageSection
        settings={settings([
          {
            calls: 12,
            withUsage: 10,
            input: 45210,
            output: 8300,
            cached: 3000,
          },
        ])}
      />,
    );
    const coverage = `${KEY}.coverage:${JSON.stringify({ count: 12, withUsage: 10 })}`;
    const line = screen.getByText(
      `${KEY}.tokens:${JSON.stringify({ input: "45.2K", output: "8.3K", cached: "3K" })} · ${coverage}`,
    );
    expect(line.getAttribute("title")).toBe(
      `${KEY}.tokens:${JSON.stringify({ input: "45,210", output: "8,300", cached: "3,000" })} · ${coverage}`,
    );
    expect(
      screen.getByText(`${KEY}.calls:${JSON.stringify({ count: 12 })}`),
    ).toBeTruthy();
  });

  it("says «no provider data» instead of zeros when no call reported usage", () => {
    render(<ModelUsageSection settings={settings([{ calls: 3 }])} />);
    expect(screen.getByText(`${KEY}.noProviderData`)).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${KEY}.tokens`))).toBeNull();
  });

  it("keeps the empty state when nobody called the model today", () => {
    render(<ModelUsageSection settings={settings([])} />);
    expect(screen.getByText(`${KEY}.empty`)).toBeTruthy();
  });
});
