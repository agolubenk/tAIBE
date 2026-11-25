import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HttpError } from "@/lib/http-error";
import type { OwnerQueuePage, OwnerQueueRow } from "../forest-types";
import { OwnerQueueTab } from "./owner-queue-tab";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/lib/format", () => ({
  formatDateTime: (value: unknown) => String(value),
  formatRelativeTime: () => "5 min ago",
}));

const state = vi.hoisted(() => ({
  page: null as unknown,
  error: null as unknown,
  filters: [] as unknown[],
  docError: null as unknown,
}));

vi.mock("@/hooks/queries/forest/use-owner-queue", () => ({
  default: (_workspaceId: string, filter: unknown) => {
    state.filters.push(filter);
    return {
      data: state.error ? undefined : state.page,
      error: state.error,
      isLoading: false,
      isError: Boolean(state.error),
      isFetching: false,
      isPlaceholderData: false,
    };
  },
}));

vi.mock("@/hooks/queries/forest/use-owner-queue-doc", () => ({
  default: (_workspaceId: string, collection: string, id: string) => ({
    isLoading: false,
    isError: Boolean(state.docError),
    error: state.docError,
    data: state.docError
      ? undefined
      : {
          doc: {
            id,
            version: 3,
            updatedAt: 1,
            data: { kind: "inbox", inbox: { type: "bug", text: "Body text" } },
          },
          check:
            collection === "items"
              ? {
                  id,
                  version: 1,
                  updatedAt: 2,
                  data: { choice: "a", note: "go" },
                }
              : null,
          history: [
            { at: 10, actor: "token:boards", action: "put", after: null },
          ],
          checkHistory: [],
          files: [
            {
              id: "f1",
              name: "shot.png",
              kind: "image",
              size: 2048,
              createdAt: "2026-11-14",
            },
          ],
          queueUrl: "https://console.example/queue",
        },
  }),
}));

function row(overrides: Partial<OwnerQueueRow>): OwnerQueueRow {
  return {
    id: "d-1",
    product: "taibe",
    kind: "decision",
    title: "Pick a store",
    added: null,
    source: null,
    pr: null,
    inboxType: null,
    state: "open",
    choice: null,
    done: null,
    answeredAt: null,
    updatedAt: 100,
    ...overrides,
  };
}

function page(overrides: Partial<OwnerQueuePage>): OwnerQueuePage {
  return {
    docs: [row({})],
    page: 1,
    pageSize: 50,
    order: "oldest",
    total: 1,
    products: ["hr-helper", "taibe"],
    truncated: false,
    collectionTotal: null,
    queueUrl: "https://console.example/queue",
    ...overrides,
  };
}

describe("OwnerQueueTab (TB-156)", () => {
  it("asks for open items first and resets to page 1 on a new filter", () => {
    state.error = null;
    state.filters = [];
    state.page = page({ total: 120, docs: [row({})] });

    render(<OwnerQueueTab workspaceId="ws" />);
    expect(state.filters.at(-1)).toEqual({
      collection: "items",
      state: "open",
      product: undefined,
      page: 1,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "workspace:forest.queue.next" }),
    );
    expect(state.filters.at(-1)).toMatchObject({ page: 2 });

    fireEvent.click(
      screen.getByRole("button", {
        name: "workspace:forest.queue.state.answered",
      }),
    );
    expect(state.filters.at(-1)).toMatchObject({ state: "answered", page: 1 });
  });

  it("names the order the server sorted by", () => {
    state.error = null;
    state.filters = [];
    state.page = page({ order: "newest" });
    render(<OwnerQueueTab workspaceId="ws" />);
    expect(
      screen.getByText(/workspace:forest\.queue\.order\.newest/),
    ).toBeTruthy();
  });

  it("drops the state filter for the answers collection", () => {
    state.error = null;
    state.page = page({});

    render(<OwnerQueueTab workspaceId="ws" />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "workspace:forest.queue.collection.checks",
      }),
    );
    expect(state.filters.at(-1)).toMatchObject({ collection: "checks" });
    expect(
      screen.queryByRole("button", {
        name: "workspace:forest.queue.state.open",
      }),
    ).toBeNull();
  });

  it("says when the console capped the list", () => {
    state.error = null;
    state.page = page({ truncated: true, collectionTotal: 12000 });

    render(<OwnerQueueTab workspaceId="ws" />);
    expect(screen.getByRole("status").textContent).toBe(
      "workspace:forest.queue.truncated 12000",
    );
  });

  it("opens an item with its text, answer, files and journal", () => {
    state.error = null;
    state.docError = null;
    state.page = page({});

    render(<OwnerQueueTab workspaceId="ws" />);
    fireEvent.click(screen.getByRole("button", { name: /Pick a store/ }));

    expect(screen.getByText("Body text")).toBeTruthy();
    expect(screen.getByText("workspace:forest.queue.choice a")).toBeTruthy();
    expect(screen.getByText("go")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("put")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "workspace:forest.queue.files.open" })
        .getAttribute("href"),
    ).toBe("https://console.example/queue");
  });

  it("tells the owner why the queue cannot be read", () => {
    state.page = null;
    state.error = new HttpError(
      404,
      "owner_queue_off: the owner queue is not configured",
    );
    render(<OwnerQueueTab workspaceId="ws" />);
    expect(screen.getByRole("alert").textContent).toBe(
      "workspace:forest.queue.error.off",
    );
    cleanup();

    state.error = new HttpError(502, "owner_queue_unavailable: 503");
    render(<OwnerQueueTab workspaceId="ws" />);
    expect(screen.getByRole("alert").textContent).toBe(
      "workspace:forest.queue.error.unavailable",
    );
  });
});
