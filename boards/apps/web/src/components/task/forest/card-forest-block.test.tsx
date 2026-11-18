import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CardForestBlock } from "./card-forest-block";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const state = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("@/hooks/queries/forest/use-card-context", () => ({
  default: () => ({ data: state.data }),
}));

vi.mock("./card-panel", () => ({
  CardPanel: () => <div data-testid="card-panel" />,
}));

describe("CardForestBlock", () => {
  it("starts closed and mounts the panel only when opened", () => {
    state.data = { approvals: [] };
    render(<CardForestBlock workspaceId="w" taskId="t" />);

    const trigger = screen.getByRole("button", {
      name: "tasks:card.forest.title",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("card-panel")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("card-panel")).not.toBeNull();
  });

  it("keeps the count of «да» requests on the closed block", () => {
    state.data = { approvals: [{ id: "a1" }, { id: "a2" }] };
    render(<CardForestBlock workspaceId="w" taskId="t" />);

    expect(
      screen
        .getByRole("button")
        .textContent?.includes("tasks:card.sections.approvals · 2"),
    ).toBe(true);
  });

  it("shows no count while the card context is loading", () => {
    state.data = undefined;
    render(<CardForestBlock workspaceId="w" taskId="t" />);

    expect(screen.getByRole("button").textContent).toBe(
      "tasks:card.forest.title",
    );
  });
});
