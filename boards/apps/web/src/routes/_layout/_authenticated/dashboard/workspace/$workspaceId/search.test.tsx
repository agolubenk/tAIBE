import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Route } from "./search";

const m = vi.hoisted(() => ({
  search: {} as { q?: string },
  navigate: vi.fn(),
  queries: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    ...(options as object),
    fullPath: "/dashboard/workspace/$workspaceId/search",
    useParams: () => ({ workspaceId: "w" }),
    useSearch: () => m.search,
  }),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="#home">{children}</a>
  ),
  useNavigate: () => m.navigate,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/queries/search/use-global-search", () => ({
  default: ({ q }: { q: string }) => {
    m.queries.push(q);
    return { data: { results: [] }, isLoading: false, isFetching: false };
  },
}));

vi.mock("@/components/common/workspace-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/page-title", () => ({ default: () => null }));

const SearchPage = (Route as unknown as { component: ComponentType }).component;

beforeEach(() => {
  vi.useFakeTimers();
  m.search = {};
  m.navigate.mockReset();
  m.queries = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("TB-226: ?q= from the address fills the field and searches at once", () => {
  m.search = { q: "лес" };
  render(<SearchPage />);

  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("лес");
  expect(m.queries[0]).toBe("лес");
});

it("TB-226: typing writes the query to the address after the pause", () => {
  render(<SearchPage />);

  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: " сектор " },
  });
  expect(m.navigate).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(300);
  });

  expect(m.navigate).toHaveBeenCalledWith({
    to: "/dashboard/workspace/$workspaceId/search",
    params: { workspaceId: "w" },
    search: { q: "сектор" },
    replace: true,
  });
});

it("TB-226: clearing the field removes q from the address", () => {
  m.search = { q: "лес" };
  render(<SearchPage />);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  act(() => {
    vi.advanceTimersByTime(300);
  });

  expect(m.navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ search: {} }),
  );
});

it("TB-226: back and forward change the address, the field follows", () => {
  m.search = { q: "лес" };
  const { rerender } = render(<SearchPage />);

  m.search = { q: "дерево" };
  rerender(<SearchPage />);

  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "дерево",
  );
  expect(m.queries.at(-1)).toBe("дерево");
});
