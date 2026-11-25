import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CardMemory } from "./card-memory";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The formatters read the app's i18n instance; the panel's text here does not.
vi.mock("@/lib/format", () => ({
  formatDateTime: (value: string) => value,
  formatRelativeTime: (value: string) => value,
}));

const state = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("@/hooks/queries/forest/use-card-memory", () => ({
  default: () => ({ data: state.data, isLoading: false, isError: false }),
}));

const off = (reason: string | null) => ({
  available: false,
  reason,
  stale: false,
  fetchedAt: null,
  keys: [],
});

// TB-58 (R-002): the panel tells a workspace without its claude-mem projects
// from a sleeping Mac.
describe("CardMemory when memory is off", () => {
  it("says memory is off for a workspace without a product map", () => {
    state.data = off("no-product-map");
    render(<CardMemory workspaceId="w1" taskId="t1" />);
    expect(screen.getByText("tasks:card.memory.noProductMap")).toBeTruthy();
    expect(screen.queryByText("tasks:card.memory.unavailable")).toBeNull();
  });

  it("says claude-mem is not reachable when the proxy does not answer", () => {
    for (const reason of ["worker-unreachable", null]) {
      state.data = off(reason);
      render(<CardMemory workspaceId="w1" taskId="t1" />);
      expect(screen.getByText("tasks:card.memory.unavailable")).toBeTruthy();
      cleanup();
    }
  });
});
