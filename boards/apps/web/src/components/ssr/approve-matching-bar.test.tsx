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
import {
  approveMatchingSsrDrafts,
  listSsrDraftMatches,
  type SsrDraftMatch,
} from "@/fetchers/ssr/ssr-fetchers";
import { toast } from "@/lib/toast";
import { ApproveMatchingBar } from "./approve-matching-bar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/fetchers/ssr/ssr-fetchers", () => ({
  listSsrDraftMatches: vi.fn(),
  approveMatchingSsrDrafts: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const draft = (
  versionId: string,
  path: string,
  match: SsrDraftMatch["match"] = null,
): SsrDraftMatch => ({
  entityId: `e-${versionId}`,
  versionId,
  path,
  kind: "skill",
  match,
});
const twin = {
  workspaceId: "ws-src",
  workspaceName: "aiBoards&eval",
  versionId: "src",
  number: 4,
};

function renderBar() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ApproveMatchingBar workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

describe("ApproveMatchingBar", () => {
  beforeEach(() => {
    vi.mocked(listSsrDraftMatches).mockResolvedValue([
      draft("d1", "skills/a", twin),
      draft("d2", "skills/b"),
      draft("d3", "skills/c", { ...twin, number: 7 }),
    ]);
    vi.mocked(approveMatchingSsrDrafts).mockResolvedValue({
      approved: 2,
      versionIds: ["d1", "d3"],
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("approves only the matching drafts after the owner confirms the list", async () => {
    renderBar();
    expect(
      await screen.findByText(
        'workspace:ssr.approveMatching.summary {"total":3,"matching":2}',
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'workspace:ssr.approveMatching.button {"matching":2}',
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("skills/a");
    expect(dialog).toHaveTextContent("skills/c");
    expect(dialog).not.toHaveTextContent("skills/b");
    expect(dialog).toHaveTextContent('"workspace":"aiBoards&eval","number":7');
    expect(dialog).toHaveTextContent('{"matching":2,"rest":1}');

    const confirm = screen
      .getAllByRole("button", {
        name: 'workspace:ssr.approveMatching.button {"matching":2}',
      })
      .at(-1);
    if (!confirm) throw new Error("no confirm button");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(approveMatchingSsrDrafts).toHaveBeenCalledWith("ws-1", [
        "d1",
        "d3",
      ]),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'workspace:ssr.approveMatching.done {"approved":2}',
      ),
    );
  });

  it("keeps the button disabled when no draft matches", async () => {
    vi.mocked(listSsrDraftMatches).mockResolvedValue([draft("d2", "skills/b")]);
    renderBar();
    const button = await screen.findByRole("button", {
      name: 'workspace:ssr.approveMatching.button {"matching":0}',
    });
    expect(button).toBeDisabled();
  });
});
