import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  approveSsrDraft,
  getSsrDiff,
  listSsrDraftMatches,
  listSsrEntities,
  rejectSsrDraft,
  type SsrDiff,
  type SsrEntity,
} from "@/fetchers/ssr/ssr-fetchers";
import { HttpError } from "@/lib/http-error";
import { RegistryTab } from "./registry-tab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/fetchers/ssr/ssr-fetchers", () => ({
  approveSsrDraft: vi.fn(),
  getSsrDiff: vi.fn(),
  listSsrDraftMatches: vi.fn(),
  listSsrEntities: vi.fn(),
  rejectSsrDraft: vi.fn(),
  rollbackSsrEntity: vi.fn(),
}));
vi.mock("./approve-matching-bar", () => ({ ApproveMatchingBar: () => null }));

const entity: SsrEntity = {
  id: "e-1",
  kind: "skill",
  name: "alpha",
  path: ".claude/skills/alpha/SKILL.md",
  status: "draft",
  latestVersionId: null,
  updatedAt: "2026-11-13T19:00:00.000Z",
  versions: [
    {
      id: "v-1",
      number: 1,
      status: "draft",
      origin: "sync",
      message: null,
      commitSha: null,
      createdAt: "2026-11-13T19:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
    },
  ],
};
const diff = (toBlobSha: string): SsrDiff => ({
  from: 1,
  to: 1,
  toVersionId: "v-1",
  toBlobSha,
  files: [{ path: entity.path, diff: `+${toBlobSha}` }],
});

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(listSsrEntities).mockResolvedValue([entity]);
  vi.mocked(listSsrDraftMatches).mockResolvedValue([]);
  render(
    <QueryClientProvider client={client}>
      <RegistryTab workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

describe("RegistryTab: a single decision names the bytes of the open diff (TB-88)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends the diff's sha; a changed draft reloads the diff and the next click sends the new sha", async () => {
    vi.mocked(getSsrDiff)
      .mockResolvedValueOnce(diff("a".repeat(64)))
      .mockResolvedValue(diff("b".repeat(64)));
    vi.mocked(approveSsrDraft)
      .mockRejectedValueOnce(
        new HttpError(409, "changed", { code: "SSR_DRAFT_CHANGED" }),
      )
      .mockResolvedValue({ entityId: "e-1", versionId: "v-1", number: 1 });
    renderTab();

    const approve = await screen.findByRole("button", {
      name: "workspace:ssr.approve",
    });
    expect(approve).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace:ssr.diffShow" }),
    );
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);

    await waitFor(() =>
      expect(approveSsrDraft).toHaveBeenCalledWith(
        "ws-1",
        "e-1",
        "v-1",
        "a".repeat(64),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "workspace:ssr.draftChanged",
    );
    await waitFor(() => expect(getSsrDiff).toHaveBeenCalledTimes(2));
    await screen.findByText(`+${"b".repeat(64)}`);

    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveSsrDraft).toHaveBeenLastCalledWith(
        "ws-1",
        "e-1",
        "v-1",
        "b".repeat(64),
      ),
    );
  });

  it("reject sends the same sha; any other failure keeps the generic error", async () => {
    vi.mocked(getSsrDiff).mockResolvedValue(diff("c".repeat(64)));
    vi.mocked(rejectSsrDraft).mockRejectedValue(
      new HttpError(409, "Version is not an open draft", { code: "CONFLICT" }),
    );
    renderTab();

    fireEvent.click(
      await screen.findByRole("button", { name: "workspace:ssr.diffShow" }),
    );
    const reject = screen.getByRole("button", { name: "workspace:ssr.reject" });
    await waitFor(() => expect(reject).toBeEnabled());
    fireEvent.click(reject);

    await waitFor(() =>
      expect(rejectSsrDraft).toHaveBeenCalledWith(
        "ws-1",
        "e-1",
        "v-1",
        "c".repeat(64),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "workspace:ssr.loadError",
    );
    expect(getSsrDiff).toHaveBeenCalledTimes(1);
  });
});
