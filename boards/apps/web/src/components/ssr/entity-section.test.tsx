import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getSsrDiff,
  type SsrEntity,
  type SsrVersionSummary,
} from "@/fetchers/ssr/ssr-fetchers";
import { EntitySection } from "./entity-section";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/fetchers/ssr/ssr-fetchers", () => ({
  approveSsrDraft: vi.fn(),
  getSsrDiff: vi.fn(),
  rejectSsrDraft: vi.fn(),
  rollbackSsrEntity: vi.fn(),
}));

const version = (number: number, status = "approved"): SsrVersionSummary => ({
  id: `v-${number}`,
  number,
  status,
  origin: "sync",
  message: null,
  commitSha: null,
  createdAt: "2026-11-14T13:00:00.000Z",
  approvedBy: null,
  approvedAt: null,
});
const entity = (kind: string, versions: SsrVersionSummary[]): SsrEntity => ({
  id: "e-1",
  kind,
  name: "brief",
  path: ".ai/templates/brief.md",
  status: "active",
  latestVersionId: null,
  updatedAt: "2026-11-14T13:00:00.000Z",
  versions,
});

function renderSection(item: SsrEntity, latestNumber: number | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EntitySection
        workspaceId="ws-1"
        entity={item}
        latestNumber={latestNumber}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EntitySection", () => {
  it("labels a known kind and shows an unknown kind as it comes", () => {
    renderSection(entity("template", [version(1, "latest")]), 1);
    expect(screen.getByText("workspace:ssr.kind.template")).toBeTruthy();
    cleanup();
    renderSection(entity("hologram", [version(1, "latest")]), 1);
    expect(screen.getByText("hologram")).toBeTruthy();
  });

  it("shows the ten newest versions only", () => {
    const versions = Array.from({ length: 12 }, (_, index) =>
      version(12 - index),
    );
    renderSection(entity("skill", versions), 12);
    // The "diff from" select still offers every version; rows stop at ten.
    const rows = screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".font-mono.text-sm")?.textContent);
    expect(rows).toEqual(versions.slice(0, 10).map((v) => `v${v.number}`));
  });

  it("keeps approve disabled until the diff is on screen", async () => {
    vi.mocked(getSsrDiff).mockResolvedValue({
      from: 1,
      to: 2,
      files: [{ path: ".ai/templates/brief.md", diff: "+new line" }],
    } as Awaited<ReturnType<typeof getSsrDiff>>);
    renderSection(
      entity("template", [version(2, "draft"), version(1, "latest")]),
      1,
    );

    const approve = screen.getByRole("button", {
      name: "workspace:ssr.approve",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    const [showDraftDiff] = screen.getAllByRole("button", {
      name: "workspace:ssr.diffShow",
    });
    if (!showDraftDiff) throw new Error("no diff button");
    fireEvent.click(showDraftDiff);
    expect(await screen.findByText("+new line")).toBeTruthy();
    expect(approve.disabled).toBe(false);
    expect(getSsrDiff).toHaveBeenCalledWith("ws-1", "e-1", "latest", "2");
  });
});
