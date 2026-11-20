import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import TaskLayout from "./task-layout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/common/layout", () => {
  const Layout = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  Layout.Header = ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  );
  Layout.Content = ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  );
  return { default: Layout };
});

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">sidebar</button>,
}));

vi.mock("@/components/common/header/task-crumb-select", () => ({
  default: () => null,
}));

vi.mock("@/components/shortcuts/shortcut-keys", () => ({
  ShortcutKeys: () => null,
}));

vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({ data: { name: "P", slug: "TB" }, error: null }),
}));

vi.mock("@/hooks/queries/task/use-get-task", () => ({
  default: () => ({ data: { number: 230 } }),
}));

vi.mock("@/hooks/use-project-websocket", () => ({
  useProjectWebSocket: () => {},
}));

type Listener = () => void;

/**
 * A matchMedia stub for `(width < Nrem)` that follows a fake width. Media
 * query rem is the browser font size (16px by default), as in a browser.
 */
function stubViewport(initialWidth: number, browserFontPx = 16) {
  let width = initialWidth;
  const listeners = new Set<Listener>();
  const matches = (query: string) => {
    const below = /width\s*<\s*(\d+)rem/.exec(query);
    return below ? width < Number(below[1]) * browserFontPx : false;
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches(query);
    },
    media: query,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }));
  return {
    resize(next: number) {
      width = next;
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
}

function renderLayout() {
  return render(
    <TaskLayout
      taskId="t"
      projectId="p"
      workspaceId="w"
      rail={<div data-testid="rail" />}
    >
      <p>body</p>
    </TaskLayout>,
  );
}

describe("TaskLayout rail (TB-230)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not mount the rail on a phone", () => {
    stubViewport(390);
    renderLayout();

    expect(screen.getByText("body")).not.toBeNull();
    expect(screen.queryByTestId("rail")).toBeNull();
  });

  it("mounts the rail on a wide screen", () => {
    stubViewport(1440);
    renderLayout();

    expect(screen.getByTestId("rail")).not.toBeNull();
  });

  it("mounts the rail at exactly 1024px, where lg:flex starts", () => {
    stubViewport(1024);
    renderLayout();

    expect(screen.getByTestId("rail")).not.toBeNull();
  });

  it("uses the lg edge in rem, as the lg:flex CSS does", () => {
    // Browser font 14px: lg starts at 896px, so 960px shows the rail.
    stubViewport(960, 14);
    const { unmount } = renderLayout();
    expect(screen.getByTestId("rail")).not.toBeNull();
    unmount();

    // Browser font 20px: lg starts at 1280px, so 1100px hides it.
    stubViewport(1100, 20);
    renderLayout();
    expect(screen.queryByTestId("rail")).toBeNull();
  });

  it("mounts the rail when a phone-width screen grows past lg", () => {
    const viewport = stubViewport(390);
    renderLayout();
    expect(screen.queryByTestId("rail")).toBeNull();

    act(() => viewport.resize(1440));
    expect(screen.getByTestId("rail")).not.toBeNull();
  });

  it("keeps the rail mounted after the screen was wide (Claude lens #426 B1)", () => {
    // A tablet turned from landscape to portrait: the rail's open dialog
    // (card meta draft) lives in its state and must survive.
    const viewport = stubViewport(1440);
    renderLayout();
    const rail = screen.getByTestId("rail");

    act(() => viewport.resize(390));
    expect(screen.getByTestId("rail")).toBe(rail);

    act(() => viewport.resize(1440));
    expect(screen.getByTestId("rail")).toBe(rail);
  });

  it("mounts the rail without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    renderLayout();

    expect(screen.getByTestId("rail")).not.toBeNull();
  });

  it("removes its media listener on unmount", () => {
    const viewport = stubViewport(1440);
    const { unmount } = renderLayout();
    expect(viewport.listenerCount()).toBe(1);

    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });
});
