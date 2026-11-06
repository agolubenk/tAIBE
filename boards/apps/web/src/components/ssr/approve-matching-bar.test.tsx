import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  approveMatchingSsrDrafts,
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
  approveMatchingSsrDrafts: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KEY = "workspace:ssr.approveMatching";
const source = (workspaceId: string, number: number) => ({
  workspaceId,
  workspaceName: workspaceId === "ws-a" ? "aiBoards&eval" : "Other",
  versionId: `src-${number}`,
  number,
});
const draft = (
  id: string,
  path: string,
  match: SsrDraftMatch["match"] = null,
): SsrDraftMatch => ({
  entityId: `e-${id}`,
  versionId: id,
  path,
  kind: "skill",
  blobSha: `sha-${id}`,
  match,
});

function renderBar(drafts: SsrDraftMatch[], onLocate = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ApproveMatchingBar
        workspaceId="ws-1"
        drafts={drafts}
        status="success"
        onLocate={onLocate}
      />
    </QueryClientProvider>,
  );
  return onLocate;
}

describe("ApproveMatchingBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("groups the dialog by source workspace, approves the matches with their sha, then lists what is left", async () => {
    vi.mocked(approveMatchingSsrDrafts).mockResolvedValue({
      approved: 3,
      versionIds: ["d1", "d3", "d4"],
    });
    const onLocate = renderBar([
      draft("d1", "skills/a", source("ws-a", 4)),
      draft("d2", "skills/b"),
      draft("d3", "skills/c", source("ws-a", 7)),
      draft("d4", "skills/d", source("ws-b", 2)),
    ]);
    expect(
      screen.getByText(`${KEY}.summary {"total":4,"matching":3}`),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: `${KEY}.button {"matching":3}` }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        `${KEY}.group {"workspace":"aiBoards&eval","count":2}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(`${KEY}.group {"workspace":"Other","count":1}`),
    ).toBeInTheDocument();
    expect(within(dialog).getByTitle("skills/c")).toHaveTextContent("v7");
    expect(dialog).not.toHaveTextContent("skills/b");
    expect(dialog).toHaveTextContent(
      `${KEY}.description {"count":3,"workspaces":"aiBoards&eval, Other"}`,
    );
    expect(dialog).toHaveTextContent(`${KEY}.rest {"count":1}`);
    const list = within(dialog).getByRole("region", {
      name: `${KEY}.listLabel`,
    });
    expect(list).toHaveAttribute("tabindex", "0");

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: `${KEY}.button {"matching":3}`,
      }),
    );
    await waitFor(() =>
      expect(approveMatchingSsrDrafts).toHaveBeenCalledWith("ws-1", [
        { versionId: "d1", blobSha: "sha-d1" },
        { versionId: "d3", blobSha: "sha-d3" },
        { versionId: "d4", blobSha: "sha-d4" },
      ]),
    );
    expect(toast.success).toHaveBeenCalledWith(`${KEY}.done {"count":3}`);

    // What is left for per-item review is listed and leads to its entity.
    expect(
      await screen.findByText(`${KEY}.left {"count":1}`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "skills/b" }));
    expect(onLocate).toHaveBeenCalledWith("e-d2");
    expect(
      screen.queryByRole("button", { name: /approveMatching\.button/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the button when no draft matches", () => {
    renderBar([draft("d2", "skills/b")]);
    expect(
      screen.getByText(`${KEY}.summary {"total":1,"matching":0}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("sends the first 200 of more matches and says so on the button", async () => {
    vi.mocked(approveMatchingSsrDrafts).mockResolvedValue({
      approved: 200,
      versionIds: [],
    });
    renderBar(
      Array.from({ length: 230 }, (_, i) =>
        draft(`d${i}`, `skills/${i}`, source("ws-a", 1)),
      ),
    );
    const label = `${KEY}.buttonPartial {"batch":200,"matching":230}`;
    fireEvent.click(screen.getByRole("button", { name: label }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`${KEY}.later {"count":30}`);
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    await waitFor(() => expect(approveMatchingSsrDrafts).toHaveBeenCalled());
    const [, items] = vi.mocked(approveMatchingSsrDrafts).mock.calls[0] ?? [];
    expect(items).toHaveLength(200);
    expect(items?.[0]).toEqual({ versionId: "d0", blobSha: "sha-d0" });
  });
});
