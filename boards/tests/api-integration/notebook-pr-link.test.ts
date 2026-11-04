import { randomUUID } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { clearVectorCacheForTests } from "../../apps/api/src/notebook/search/vector-index";
import { syncNotebookCards } from "../../apps/api/src/scheduler/notebook-card-sync";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// Synthetic repo, PR and page only; GitHub and the network are mocked.
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  pullsGet: vi.fn(),
  listComments: vi.fn(),
  page: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock(
  "../../apps/api/src/plugins/github/utils/github-app",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/plugins/github/utils/github-app")
    >()),
    getVerifiedInstallationOctokit: mocks.verify,
  }),
);
vi.mock("../../apps/api/src/import/destination-fetch", async (original) => ({
  ...(await original<
    typeof import("../../apps/api/src/import/destination-fetch")
  >()),
  publicDestinationFetch: mocks.page,
}));

const PR_URL = "https://github.com/example/repo/pull/7";
// A public IP literal: the destination check needs no DNS.
const PAGE_URL = "https://93.184.216.34/lease";

function pullRequest(body: string) {
  return {
    data: {
      title: "Аренда карточек",
      body,
      state: "open",
      merged: false,
      draft: false,
      html_url: PR_URL,
      user: { login: "ann" },
      base: { ref: "main" },
      head: { ref: "feat/lease" },
      comments: 1,
    },
  };
}

async function notebook() {
  const forest = await createForest();
  const path = (rest: string) => `/notebook/${forest.workspace.id}${rest}`;
  const owner = (method: string, rest: string, body?: unknown) =>
    forest.ownerApi(method, path(rest), body);
  const search = async (query: string) =>
    (await owner("POST", "/search", { query, mode: "keyword" })).body
      .results as { source: { kind: string; ref: string } }[];
  return { ...forest, path, owner, search };
}

async function linkRepo(projectId: string, verifiedByUserId: string) {
  await db.insert(schema.integrationTable).values({
    projectId,
    type: "github",
    isActive: true,
    config: JSON.stringify({
      repositoryOwner: "Example",
      repositoryName: "Repo",
      installationId: 1,
      repositoryId: 2,
      verifiedGithubAccountId: "3",
      verifiedByUserId,
    }),
  });
}

async function addMember(workspaceId: string, restricted: boolean) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Member",
    })
    .returning();
  if (!user) throw new Error("user not created");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role: "member",
    joinedAt: new Date(),
  });
  if (restricted) {
    await db.insert(schema.workspaceMemberAccessTable).values({
      workspaceId,
      userId: user.id,
      projectAccess: "selected",
    });
  }
  return user;
}

describe("API integration: notebook PR and link sources", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearVectorCacheForTests();
    mocks.pullsGet.mockReset();
    mocks.listComments.mockReset().mockResolvedValue({
      data: [
        {
          body: "Fencing проверен на стенде.",
          created_at: "2026-10-30T06:52:00Z",
          user: { login: "bob" },
        },
      ],
    });
    mocks.verify.mockReset().mockResolvedValue({
      rest: {
        pulls: { get: mocks.pullsGet },
        issues: { listComments: mocks.listComments },
      },
    });
    mocks.page.mockReset();
  });
  afterEach(resetEmbedQueueForTests);

  it("adds a PR, finds it by search and refreshes its text in place", async () => {
    const nb = await notebook();
    await linkRepo(nb.project.id, nb.ownerId);
    mocks.pullsGet.mockResolvedValue(pullRequest("Аренда истекает через час."));

    const added = await nb.owner("POST", "/sources/github-pr", { url: PR_URL });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      kind: "github-pr",
      ref: "example/repo#7",
      title: "example/repo#7 Аренда карточек",
      changed: true,
    });
    expect(added.body.chunks).toBeGreaterThan(0);
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 2, installationId: 1 }),
      true,
    );
    expect(mocks.pullsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "Example",
        repo: "Repo",
        pull_number: 7,
      }),
    );
    expect((await nb.search("fencing"))[0]?.source).toMatchObject({
      kind: "github-pr",
      ref: "example/repo#7",
    });

    const again = await nb.owner("POST", "/sources/github-pr", {
      url: "Example/Repo#7",
    });
    expect(again.body).toMatchObject({ ref: "example/repo#7", changed: false });

    mocks.pullsGet.mockResolvedValue(
      pullRequest("Рубка переносится на пятницу."),
    );
    mocks.listComments.mockResolvedValue({ data: [] });
    const refreshed = await nb.owner("POST", "/sources/github-pr", {
      url: "example/repo#7",
    });
    expect(refreshed.body).toMatchObject({ changed: true });
    expect(await nb.search("fencing")).toEqual([]);
    expect((await nb.search("пятницу"))[0]?.source.ref).toBe("example/repo#7");
    const sources = (await nb.owner("GET", "/sources")).body.sources;
    expect(
      sources.filter((s: { kind: string }) => s.kind === "github-pr"),
    ).toHaveLength(1);
  });

  it("refuses a PR with a 4xx when the repo is not linked to a project every member may open", async () => {
    const nb = await notebook();
    const notLinked = await nb.owner("POST", "/sources/github-pr", {
      url: PR_URL,
    });
    expect(notLinked.status).toBe(422);
    expect(notLinked.body.code).toBe("PR_REPO_NOT_LINKED");

    await db.insert(schema.integrationTable).values({
      projectId: nb.project.id,
      type: "github",
      isActive: true,
      config: JSON.stringify({
        repositoryOwner: "example",
        repositoryName: "repo",
        installationId: 1,
      }),
    });
    const unverified = await nb.owner("POST", "/sources/github-pr", {
      url: PR_URL,
    });
    expect(unverified.body.code).toBe("PR_REPO_NOT_LINKED");
    expect(mocks.verify).not.toHaveBeenCalled();

    const other = await notebook();
    await linkRepo(other.project.id, other.ownerId);
    await addMember(other.workspace.id, true);
    const restricted = await other.owner("POST", "/sources/github-pr", {
      url: PR_URL,
    });
    expect(restricted.status).toBe(422);
    expect(restricted.body.code).toBe("PR_REPO_NOT_LINKED");

    const invalid = await other.owner("POST", "/sources/github-pr", {
      url: "https://github.com/example/repo/issues/7",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("PR_INVALID_URL");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("drops a stored PR once its project is no longer open to every member", async () => {
    const nb = await notebook();
    await linkRepo(nb.project.id, nb.ownerId);
    mocks.pullsGet.mockResolvedValue(pullRequest("Аренда истекает через час."));
    await nb.owner("POST", "/sources/github-pr", { url: PR_URL });

    await syncNotebookCards();
    expect((await nb.search("fencing"))[0]?.source.ref).toBe("example/repo#7");

    await addMember(nb.workspace.id, true);
    await syncNotebookCards();
    expect(await nb.search("fencing")).toEqual([]);
  });

  it("answers a missing PR or a missing GitHub App without a 500", async () => {
    const nb = await notebook();
    await linkRepo(nb.project.id, nb.ownerId);

    mocks.pullsGet.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const missing = await nb.owner("POST", "/sources/github-pr", {
      url: PR_URL,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("PR_NOT_FOUND");

    mocks.pullsGet.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      }),
    );
    const denied = await nb.owner("POST", "/sources/github-pr", {
      url: PR_URL,
    });
    expect([denied.status, denied.body.code]).toEqual([
      422,
      "GITHUB_NO_ACCESS",
    ]);

    mocks.pullsGet.mockRejectedValue(new Error("socket hang up"));
    const down = await nb.owner("POST", "/sources/github-pr", { url: PR_URL });
    expect([down.status, down.body.code]).toEqual([502, "GITHUB_UNAVAILABLE"]);

    mocks.verify.mockRejectedValue(new Error("GitHub App not configured"));
    const noApp = await nb.owner("POST", "/sources/github-pr", { url: PR_URL });
    expect(noApp.status).toBe(503);
    expect(noApp.body.code).toBe("GITHUB_APP_NOT_CONFIGURED");
  });

  it("adds a page by its link, refreshes it, and refuses private and plain-http links", async () => {
    const nb = await notebook();
    mocks.page.mockImplementation(
      async () =>
        new Response(
          "<title>Аренда</title><h2>Срок</h2><p>Аренда истекает через час, fencing держит.</p><script>secret()</script>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );

    const added = await nb.owner("POST", "/sources/link", {
      url: `${PAGE_URL}#top`,
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      kind: "link",
      ref: PAGE_URL,
      title: "Аренда",
      changed: true,
    });
    expect((await nb.search("fencing"))[0]?.source).toMatchObject({
      kind: "link",
      ref: PAGE_URL,
    });
    expect(await nb.search("secret")).toEqual([]);
    expect(
      (await nb.owner("POST", "/sources/link", { url: PAGE_URL })).body.changed,
    ).toBe(false);

    mocks.page.mockImplementationOnce(
      async () =>
        new Response("# Аренда\n\nПродлена до пятницы.", {
          headers: { "content-type": "text/markdown" },
        }),
    );
    const refreshed = await nb.owner("POST", "/sources/link", {
      url: PAGE_URL,
    });
    expect(refreshed.body).toMatchObject({ ref: PAGE_URL, changed: true });
    expect(await nb.search("fencing")).toEqual([]);
    expect((await nb.search("пятницы"))[0]?.source.ref).toBe(PAGE_URL);

    mocks.page.mockImplementationOnce(
      async () =>
        new Response("## a\n\nb\n\n".repeat(2001), {
          headers: { "content-type": "text/plain" },
        }),
    );
    const flood = await nb.owner("POST", "/sources/link", { url: PAGE_URL });
    expect([flood.status, flood.body.code]).toEqual([
      413,
      "SOURCE_TOO_MANY_CHUNKS",
    ]);
    expect((await nb.search("пятницы"))[0]?.source.ref).toBe(PAGE_URL);

    for (const [url, status, code] of [
      ["https://127.0.0.1/admin", 422, "LINK_PRIVATE_DESTINATION"],
      ["https://localhost:5432/", 422, "LINK_PRIVATE_DESTINATION"],
      ["http://93.184.216.34/lease", 400, "LINK_NOT_HTTPS"],
    ] as const) {
      const refused = await nb.owner("POST", "/sources/link", { url });
      expect([refused.status, refused.body.code]).toEqual([status, code]);
    }
    // Add, unchanged, refresh and flood; the refused links send nothing.
    expect(mocks.page).toHaveBeenCalledTimes(4);

    mocks.page.mockResolvedValue(
      new Response("%PDF-1.7", {
        headers: { "content-type": "application/pdf" },
      }),
    );
    const pdf = await nb.owner("POST", "/sources/link", { url: PAGE_URL });
    expect([pdf.status, pdf.body.code]).toEqual([415, "LINK_PDF_UNSUPPORTED"]);
  });

  it("needs manage_settings to add a link or a PR", async () => {
    const nb = await notebook();
    const member = await addMember(nb.workspace.id, false);
    mockAuthenticatedSession(member);
    const { app } = createApp();
    for (const [rest, url] of [
      ["/sources/link", PAGE_URL],
      ["/sources/github-pr", PR_URL],
    ]) {
      const denied = await app.request(`/api${nb.path(rest ?? "")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(denied.status).toBe(403);
    }
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
