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

type Forest = Awaited<ReturnType<typeof createForest>>;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const commitSha = "7071727374757677787970717273747576777879";

// One served-latest file, so the workspace has something to push.
async function servedCorpus(forest: Forest) {
  const text = `note of ${forest.workspace.id}`;
  const synced = await forest.ownerApi(
    "POST",
    `/ssr/${forest.workspace.id}/sync`,
    {
      commitSha,
      files: [
        {
          path: ".claude/skills/push/NOTE.md",
          sha256: sha256(text),
          content: text,
        },
      ],
    },
  );
  const [draft] = synced.body.created;
  const [entity] = await db
    .select()
    .from(ssrEntityTable)
    .where(eq(ssrEntityTable.workspaceId, forest.workspace.id));
  if (!draft || !entity) throw new Error("the sync made no draft");
  await approveDraft(
    forest.workspace.id,
    entity.id,
    draft.versionId,
    forest.ownerId,
  );
}

// TB-93: one repo for every workspace put the corpus of one product into the
// main of another. Each workspace now pushes only into its own repo.
describe("API integration: SSR push-back repo per workspace", () => {
  const urls: string[] = [];

  beforeEach(async () => {
    await resetTestDatabase();
    // Every file is new to the repo; the commit stops at the ref read. The
    // full-commit test below brings a GitHub that accepts every write.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        return new Response("{}", {
          status: url.includes("/contents/") ? 404 : 503,
        });
      }),
    );
    vi.stubEnv("SSR_PUSH_GITHUB_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("pushes a workspace only into its own repo and skips one without a repo", async () => {
    const mapped = await createForest();
    const unmapped = await createForest();
    await servedCorpus(mapped);
    await servedCorpus(unmapped);
    vi.stubEnv("SSR_PUSH_REPOS", `${mapped.workspace.id}=acme/product-a`);
    vi.stubEnv("SSR_PUSH_GITHUB_REPO", "acme/product-b");
    urls.length = 0;

    expect(await pushChangeset(unmapped.workspace.id, "m")).toMatchObject({
      pushed: false,
      reason: "no_repo",
    });
    expect(urls).toEqual([]);

    const nightly = await runNightlySsrPush();
    // The stubbed ref read fails, so the mapped workspace reports degraded.
    expect(nightly.degraded).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/api\.github\.com\/repos\/acme\/product-a\//,
      );
    }
  });

  it("sends the whole commit, every read and write, into the workspace's own repo", async () => {
    const mapped = await createForest();
    const other = await createForest();
    await servedCorpus(mapped);
    await servedCorpus(other);
    vi.stubEnv(
      "SSR_PUSH_REPOS",
      `${mapped.workspace.id}=acme/product-a,${other.workspace.id}=acme/product-b`,
    );
    // A GitHub that accepts the commit: the file is new, then ref, base
    // commit, blob, tree, new commit and the ref update all succeed.
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status });
        if (url.includes("/contents/")) return json({}, 404);
        if (url.includes("/git/ref/heads/"))
          return json({ object: { sha: "base-commit" } });
        if (method === "GET" && url.includes("/git/commits/"))
          return json({ tree: { sha: "base-tree" } });
        if (url.endsWith("/git/blobs")) return json({ sha: "blob-1" }, 201);
        if (url.endsWith("/git/trees")) return json({ sha: "tree-1" }, 201);
        if (url.endsWith("/git/commits"))
          return json({ sha: "new-commit" }, 201);
        if (url.includes("/git/refs/heads/")) return json({});
        return json({ message: "unexpected" }, 500);
      }),
    );

    expect(await pushChangeset(mapped.workspace.id, "m")).toMatchObject({
      pushed: true,
      commitSha: "new-commit",
    });

    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.url.replace(/^.*\/git\//, ""))).toEqual(
      expect.arrayContaining(["blobs", "trees", "commits"]),
    );
    expect(writes.some((call) => /\/git\/refs\/heads\//.test(call.url))).toBe(
      true,
    );
    for (const call of calls) {
      expect(call.url).toMatch(
        /^https:\/\/api\.github\.com\/repos\/acme\/product-a\//,
      );
    }
  });

  it("pushes nothing when only the old single-repo variable is set", async () => {
    const forest = await createForest();
    await servedCorpus(forest);
    vi.stubEnv("SSR_PUSH_GITHUB_REPO", "acme/product-b");
    vi.stubEnv("SSR_PUSH_REPOS", "");
    urls.length = 0;

    expect(await runNightlySsrPush()).toEqual({});
    expect(await pushChangeset(forest.workspace.id, "m")).toMatchObject({
      pushed: false,
      reason: "no_repo",
    });
    expect(urls).toEqual([]);
  });
});
