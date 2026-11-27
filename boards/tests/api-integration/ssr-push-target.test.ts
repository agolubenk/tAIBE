import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrPushStateTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { runNightlySsrPush } from "../../apps/api/src/scheduler/ssr-nightly-push";
import { approveDraft } from "../../apps/api/src/ssr/approve";
import { pushChangeset } from "../../apps/api/src/ssr/pushback";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// The same corpus path in two workspaces, as the layer files of two products.
const path = ".claude/rules/01-base.md";
const saved = {
  tokenFile: process.env.SSR_PUSH_GITHUB_TOKEN_FILE,
  targets: process.env.SSR_PUSH_TARGETS,
};

async function servedWorkspace(text: string) {
  const forest = await createForest();
  const workspaceId = forest.workspace.id;
  const synced = await forest.ownerApi("POST", `/ssr/${workspaceId}/sync`, {
    commitSha: "6061626364656667686960616263646566676869",
    files: [{ path, sha256: sha256(text), content: text }],
  });
  expect(synced.status).toBe(200);
  const [draft] = synced.body.created;
  const [entity] = await db
    .select()
    .from(ssrEntityTable)
    .where(eq(ssrEntityTable.workspaceId, workspaceId));
  if (!entity || !draft) throw new Error("the sync made no draft");
  const [version] = await db
    .select({ blobSha: ssrVersionTable.blobSha })
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.id, draft.versionId));
  if (!version) throw new Error("no draft row");
  // TB-88: the owner approves the bytes the diff showed (id and blob sha).
  await approveDraft(
    workspaceId,
    entity.id,
    { versionId: draft.versionId, blobSha: version.blobSha },
    forest.ownerId,
  );
  return workspaceId;
}

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe("API integration: SSR push-back goes to the workspace's own repo (TB-160)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
  let directory: string;

  beforeEach(async () => {
    await resetTestDatabase();
    // The token comes from its file only (TB-116).
    directory = mkdtempSync(join(tmpdir(), "tb160-push-target-"));
    const tokenFile = join(directory, "ssr_push_github_token");
    writeFileSync(tokenFile, "test-token\n", { mode: 0o400 });
    process.env.SSR_PUSH_GITHUB_TOKEN_FILE = tokenFile;
    delete process.env.SSR_PUSH_TARGETS;
    fetchMock = vi.fn(
      async () => new Response("unavailable in tests", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restore("SSR_PUSH_GITHUB_TOKEN_FILE", saved.tokenFile);
    rmSync(directory, { recursive: true, force: true });
    restore("SSR_PUSH_TARGETS", saved.targets);
  });

  it("does not push a workspace without a target, and makes no GitHub call", async () => {
    const lavaeon = await servedWorkspace("hr rules");
    const taibe = await servedWorkspace("taibe rules");
    process.env.SSR_PUSH_TARGETS = `${lavaeon}=owner-a/repo-a@main`;

    const result = await pushChangeset(taibe, "test push");

    expect(result).toEqual({
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
      reason: "no_target",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads and writes only the repo and branch of the workspace", async () => {
    const lavaeon = await servedWorkspace("hr rules");
    const taibe = await servedWorkspace("taibe rules");
    process.env.SSR_PUSH_TARGETS = `${lavaeon}=owner-a/repo-a@main,${taibe}=owner-b/repo-b@feature/ssr`;

    // The mocked GitHub answers 500: the first read fails the push.
    await expect(pushChangeset(taibe, "test push")).rejects.toThrow("HTTP 500");

    expect(urls()).toEqual([
      `https://api.github.com/repos/owner-b/repo-b/contents/${encodeURIComponent(path)}?ref=feature%2Fssr`,
    ]);
  });

  // TB-215 (from #166): the TB-93 bug was in a write step, not in the read.
  it("sends the whole commit, every read and write, into the repo and branch of the workspace", async () => {
    const lavaeon = await servedWorkspace("hr rules");
    const taibe = await servedWorkspace("taibe rules");
    process.env.SSR_PUSH_TARGETS = `${lavaeon}=owner-a/repo-a@main,${taibe}=owner-b/repo-b@feature/ssr`;
    const pushState = (workspaceId: string) =>
      db
        .select()
        .from(ssrPushStateTable)
        .where(eq(ssrPushStateTable.workspaceId, workspaceId));
    const otherBefore = await pushState(lavaeon);

    // A GitHub that accepts the commit: the file is new, then the ref, the
    // base commit, the blob, the tree, the new commit and the ref update.
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/contents/")) return json({}, 404);
        if (url.includes("/git/ref/heads/"))
          return json({ object: { sha: "base-commit" } });
        if (method === "GET" && url.includes("/git/commits/"))
          return json({ tree: { sha: "base-tree" } });
        if (url.endsWith("/git/blobs")) return json({ sha: "blob-1" }, 201);
        if (url.endsWith("/git/trees")) return json({ sha: "tree-1" }, 201);
        if (url.endsWith("/git/commits"))
          return json({ sha: "new-commit" }, 201);
        if (method === "PATCH" && url.includes("/git/refs/heads/"))
          return json({ object: { sha: "new-commit" } });
        return json({ message: "unexpected" }, 500);
      },
    );

    expect(await pushChangeset(taibe, "test push")).toMatchObject({
      pushed: true,
      commitSha: "new-commit",
      files: [path],
    });

    const repo = "https://api.github.com/repos/owner-b/repo-b";
    const calls = fetchMock.mock.calls.map((call) => {
      const init = (call[1] ?? {}) as RequestInit;
      return {
        call: `${init.method ?? "GET"} ${String(call[0])}`,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init.headers).get("Authorization"),
      };
    });
    expect(calls.map((call) => call.call)).toEqual([
      `GET ${repo}/contents/${encodeURIComponent(path)}?ref=feature%2Fssr`,
      `GET ${repo}/git/ref/heads/feature/ssr`,
      `GET ${repo}/git/commits/base-commit`,
      `POST ${repo}/git/blobs`,
      `POST ${repo}/git/trees`,
      `POST ${repo}/git/commits`,
      `PATCH ${repo}/git/refs/heads/feature/ssr`,
    ]);
    expect(calls.every((call) => call.auth === "Bearer test-token")).toBe(true);
    // The bytes are this workspace's; each step names the one before it.
    const [, , , blob, tree, commit, update] = calls;
    expect(
      Buffer.from(String(blob?.body.content), "base64").toString("utf8"),
    ).toBe("taibe rules");
    expect(tree?.body).toEqual({
      base_tree: "base-tree",
      tree: [{ path, mode: "100644", type: "blob", sha: "blob-1" }],
    });
    expect(commit?.body).toMatchObject({
      tree: "tree-1",
      parents: ["base-commit"],
    });
    expect(update?.body).toEqual({ sha: "new-commit" });

    const [state] = await pushState(taibe);
    expect(state).toMatchObject({
      path,
      lastPushedSha: sha256("taibe rules"),
      lastPushedCommitSha: "new-commit",
    });
    expect(await pushState(lavaeon)).toEqual(otherBefore);
  });

  it("the nightly run pushes only the workspaces with a target, each into its own repo", async () => {
    const lavaeon = await servedWorkspace("hr rules");
    await servedWorkspace("taibe rules");
    process.env.SSR_PUSH_TARGETS = `${lavaeon}=owner-a/repo-a@main`;

    expect(await runNightlySsrPush()).toEqual({ degraded: true });

    expect(urls().length).toBeGreaterThan(0);
    for (const url of urls()) {
      expect(url).toContain("/repos/owner-a/repo-a/");
    }
    expect(urls().join(" ")).not.toContain("HR_Helper-v2");
  });

  it("the nightly run does nothing without any target", async () => {
    await servedWorkspace("hr rules");
    process.env.SSR_PUSH_TARGETS = "";

    expect(await runNightlySsrPush()).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
