import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import requestPullRequestReview from "@/fetchers/external-link/request-pull-request-review";
import { HttpError } from "@/lib/http-error";
import { toast } from "@/lib/toast";
import type { ExternalLink, ExternalLinkMetadata } from "@/types/external-link";
import { ExternalLinksAccordion } from "./external-links-accordion";
import { PullRequestReview } from "./pull-request-review";

vi.mock("@/fetchers/external-link/request-pull-request-review", () => ({
  default: vi.fn(),
}));
const canUpdateTasks = vi.fn(() => true);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canUpdateTasks }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

const request = vi.mocked(requestPullRequestReview);
const REQUEST = "settings:externalLinks.review.request";

beforeEach(() => {
  vi.resetAllMocks();
  canUpdateTasks.mockReturnValue(true);
});
afterEach(cleanup);

function pr(
  metadata: ExternalLinkMetadata | null = null,
  extra: Partial<ExternalLink> = {},
): ExternalLink {
  return {
    id: "link-1",
    taskId: "task-1",
    integrationId: "integration-1",
    resourceType: "pull_request",
    externalId: "42",
    url: "https://github.com/acme/app/pull/42",
    title: "Fix login",
    metadata,
    integration: { id: "integration-1", type: "github" },
    ...extra,
  };
}

function renderReview(link: ExternalLink) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  client.setQueryData(["external-links", "task-1"], [link]);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <PullRequestReview taskId="task-1" link={link} />
    </QueryClientProvider>,
  );
  return { client, invalidate };
}

describe("review of a pull request on a button (TB-172)", () => {
  it("idle: one press asks the server once and stores the answered state", async () => {
    let answer: (link: ExternalLink) => void = () => {};
    request.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { client } = renderReview(pr({ merged: false }));
    const button = screen.getByRole("button", { name: REQUEST });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toEqual({
      taskId: "task-1",
      id: "link-1",
    });

    answer(pr({ merged: false, reviewRequested: true }));
    await waitFor(() =>
      expect(
        client.getQueryData<ExternalLink[]>(["external-links", "task-1"])?.[0]
          ?.metadata?.reviewRequested,
      ).toBe(true),
    );
  });

  it("running: the button stays off and the state is shown", () => {
    renderReview(pr({ reviewRequested: true }));
    expect(screen.getByRole("button", { name: REQUEST })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "settings:externalLinks.review.running",
    );
  });

  it("done: links to the review comment and lets a new review start", () => {
    renderReview(
      pr({
        reviewDoneAt: "2026-11-14T15:00:00.000Z",
        reviewUrl: "https://github.com/acme/app/pull/42#issuecomment-1",
      }),
    );
    expect(
      screen.getByRole("link", { name: "settings:externalLinks.review.done" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/42#issuecomment-1",
    );
    expect(screen.getByRole("button", { name: REQUEST })).toBeEnabled();
  });

  it("fork: the button is off and says why", () => {
    renderReview(pr({ fromFork: true }));
    expect(screen.getByRole("button", { name: REQUEST })).toBeDisabled();
    expect(
      screen.getByText("settings:externalLinks.review.forkOnly"),
    ).toBeInTheDocument();
  });

  it("network error: a toast, no refetch, the button is on again", async () => {
    request.mockRejectedValue(new TypeError("Failed to fetch"));
    const { invalidate } = renderReview(pr());
    const button = screen.getByRole("button", { name: REQUEST });
    fireEvent.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:externalLinks.review.errorGeneric",
      ),
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
  });

  it("409 REVIEW_RUNNING: names the reason and reads the links again", async () => {
    request.mockRejectedValue(
      new HttpError(409, "running", { code: "REVIEW_RUNNING" }),
    );
    const { invalidate } = renderReview(pr());
    fireEvent.click(screen.getByRole("button", { name: REQUEST }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:externalLinks.review.errorRunning",
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["external-links", "task-1"],
    });
  });
});

describe("where the review button shows", () => {
  function renderRow(link: ExternalLink) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalLinksAccordion taskId="task-1" externalLinks={[link]} />
      </QueryClientProvider>,
    );
    return screen.queryByRole("button", { name: REQUEST });
  }

  it("shows on an open GitHub pull request, beside the link", () => {
    const button = renderRow(pr());
    expect(button).toBeInTheDocument();
    expect(button?.closest("a")).toBeNull();
  });

  it("hides on a merged or GitLab pull request and without task:update", () => {
    expect(renderRow(pr({ merged: true }))).toBeNull();
    cleanup();
    expect(
      renderRow(pr(null, { integration: { id: "i", type: "gitlab" } })),
    ).toBeNull();
    cleanup();
    canUpdateTasks.mockReturnValue(false);
    expect(renderRow(pr())).toBeNull();
  });
});
