import { createHash } from "node:crypto";
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
import { ssrEntityTable } from "../../apps/api/src/database/ssr-schema";
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
  token: process.env.SSR_PUSH_GITHUB_TOKEN,
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
  await approveDraft(workspaceId, entity.id, draft.versionId, forest.ownerId);
  return workspaceId;
}

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe("API integration: SSR push-back goes to the workspace's own repo (TB-160)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.SSR_PUSH_GITHUB_TOKEN = "test-token";
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
    restore("SSR_PUSH_GITHUB_TOKEN", saved.token);
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
