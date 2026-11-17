import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ForestListState } from "./forest-list-state";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderState(state: { isLoading?: boolean; isError?: boolean }) {
  const onRetry = vi.fn();
  render(
    <ForestListState
      isLoading={state.isLoading ?? false}
      isError={state.isError ?? false}
      isEmpty={false}
      empty="empty"
      onRetry={onRetry}
    >
      <p>rows</p>
    </ForestListState>,
  );
  return onRetry;
}

describe("ForestListState (TB-218)", () => {
  it("offers a retry on a load error, and the button refetches", () => {
    const onRetry = renderState({ isError: true });
    expect(screen.getByRole("alert").textContent).toBe(
      "workspace:forest.loadError",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "common:error.tryAgain" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("rows")).toBeNull();
  });

  it("shows no retry while loading or when the list is loaded", () => {
    renderState({ isLoading: true });
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderState({});
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("rows")).toBeTruthy();
  });
});
