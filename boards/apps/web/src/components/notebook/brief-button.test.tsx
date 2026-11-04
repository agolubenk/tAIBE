import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BriefButton } from "./brief-button";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const state = vi.hoisted(() => ({
  llm: {
    configured: true,
    model: "test-model" as string | null,
    callsToday: 0,
    dailyMax: 50 as number | null,
  },
  mutate: (() => {}) as (threadId: string) => void,
}));

vi.mock("@/hooks/queries/notebook/use-notebook-status", () => ({
  default: () => ({ data: { llm: state.llm } }),
}));
vi.mock("@/hooks/mutations/notebook/use-brief-notebook-thread", () => ({
  default: () => ({
    mutate: state.mutate,
    isPending: false,
    variables: undefined,
  }),
}));

const button = () =>
  screen.getByRole("button", {
    name: "workspace:notebook.chat.brief.button",
  }) as HTMLButtonElement;

describe("BriefButton", () => {
  it("asks for a brief of the open thread", () => {
    const mutate = vi.fn();
    state.mutate = mutate;
    state.llm = { configured: true, model: "m", callsToday: 3, dailyMax: 50 };
    render(<BriefButton workspaceId="w1" threadId="t1" />);

    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(mutate).toHaveBeenCalledWith("t1");
  });

  it("is disabled and says why without a model", () => {
    state.llm = {
      configured: false,
      model: null,
      callsToday: 0,
      dailyMax: null,
    };
    render(<BriefButton workspaceId="w1" threadId="t1" />);

    expect(button().disabled).toBe(true);
    const hint = screen.getByText("workspace:notebook.chat.brief.noModel");
    expect(button().getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("is disabled and says why at the daily cap", () => {
    state.llm = { configured: true, model: "m", callsToday: 50, dailyMax: 50 };
    render(<BriefButton workspaceId="w1" threadId="t1" />);

    expect(button().disabled).toBe(true);
    expect(
      screen.getByText("workspace:notebook.chat.brief.capped"),
    ).toBeTruthy();
  });
});
