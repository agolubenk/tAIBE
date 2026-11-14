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
import {
  ssrBlobTable,
  ssrEntityTable,
} from "../../apps/api/src/database/ssr-schema";
import { approveDraft } from "../../apps/api/src/ssr/approve";
import {
  dropDamagedBlobs,
  pushChangeset,
} from "../../apps/api/src/ssr/pushback";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const path = ".claude/skills/integrity/NOTE.md";
const text = "approved bytes";
const repair =
  "run the Mac sync by hand (node boards/deploy/vps/mac/ssr-sync.mjs) to upload the bytes again; a file that left the checkout needs its version rolled back";
const originalToken = process.env.SSR_PUSH_GITHUB_TOKEN;

let forest: Awaited<ReturnType<typeof createForest>>;

// Bytes stored before the TB-92 sync check: the row keeps the sha, not the bytes.
const tamper = () =>
  db
    .update(ssrBlobTable)
    .set({ content: "tampered bytes" })
    .where(eq(ssrBlobTable.sha256, sha256(text)));

const storedContent = async () =>
  (
    await db
      .select({ content: ssrBlobTable.content })
      .from(ssrBlobTable)
      .where(eq(ssrBlobTable.sha256, sha256(text)))
  )[0]?.content;

// One approved version of one corpus file: the served latest that push-back
// would commit into the product repo.
async function servedFile() {
  forest = await createForest();
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

describe("API integration: SSR push-back checks blob bytes against their sha (TB-94)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetTestDatabase();
    process.env.SSR_PUSH_GITHUB_TOKEN = "test-token";
    fetchMock = vi.fn(
      async () => new Response("unavailable in tests", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalToken === undefined) delete process.env.SSR_PUSH_GITHUB_TOKEN;
    else process.env.SSR_PUSH_GITHUB_TOKEN = originalToken;
  });

  it("refuses bytes that do not hash to the version's sha, before any GitHub call", async () => {
    const workspaceId = await servedFile();
    await tamper();

    const result = await pushChangeset(workspaceId, "test push");

    expect(result).toEqual({
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
      reason: `blob_integrity: 1 file(s), first ${path}; 1 damaged blob(s) dropped, ${repair}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(path));
  });

  it("refuses a file whose blob is gone instead of skipping it silently", async () => {
    const workspaceId = await servedFile();
    await db.delete(ssrBlobTable).where(eq(ssrBlobTable.sha256, sha256(text)));

    const result = await pushChangeset(workspaceId, "test push");

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe(
      `blob_integrity: 1 file(s), first ${path}; 0 damaged blob(s) dropped, ${repair}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the damaged row, so the next sync stores the bytes again and the push goes through (TB-147)", async () => {
    const workspaceId = await servedFile();
    await tamper();

    await pushChangeset(workspaceId, "test push");
    expect(await storedContent()).toBeUndefined();

    // The Mac side: known-shas no longer names the sha, so the sync sends the
    // bytes of the unchanged file again.
    const known = await forest.ownerApi(
      "POST",
      `/ssr/${workspaceId}/known-shas`,
      { shas: [sha256(text)] },
    );
    expect(known.body.shas).toEqual([]);
    const synced = await forest.ownerApi("POST", `/ssr/${workspaceId}/sync`, {
      commitSha: "6061626364656667686960616263646566676869",
      files: [{ path, sha256: sha256(text), content: text }],
    });
    expect(synced.status).toBe(200);
    expect(await storedContent()).toBe(text);

    // The stubbed GitHub answers 500: reaching it is the proof the guard passed.
    await expect(pushChangeset(workspaceId, "test push")).rejects.toThrow(
      `GitHub contents ${path}: HTTP 500`,
    );
  });

  it("keeps a row whose bytes match its sha", async () => {
    await servedFile();

    expect(await dropDamagedBlobs([sha256(text)])).toBe(0);
    expect(await storedContent()).toBe(text);
  });

  it("lets intact bytes through to GitHub", async () => {
    const workspaceId = await servedFile();

    // The stubbed GitHub answers 500: reaching it is the proof the guard passed.
    await expect(pushChangeset(workspaceId, "test push")).rejects.toThrow(
      `GitHub contents ${path}: HTTP 500`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
