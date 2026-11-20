import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  expect(synced.status).toBe(200);
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

// TB-116: on d4dev the token never reached the app container (compose passes
// an explicit list), so push-back was always off. The token now comes from a
// secret file that the app reads on every push; the repo and branch of each
// workspace come from SSR_PUSH_TARGETS (TB-160).
describe("API integration: SSR push-back token file", () => {
  let directory: string;
  let tokenFile: string;
  const bearers: string[] = [];
  const urls: string[] = [];
  // Synthetic, so a leak into a log line is detectable and harmless.
  const synthetic = () => `ghp_synthetic_${randomBytes(12).toString("hex")}`;
  const target = (forest: Forest) =>
    vi.stubEnv(
      "SSR_PUSH_TARGETS",
      `${forest.workspace.id}=acme/product-a@main`,
    );

  // Every console line the code under test prints, flattened to text.
  function captureConsole() {
    const lines: string[] = [];
    const keep = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg),
          )
          .join(" "),
      );
    };
    for (const level of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, level).mockImplementation(keep);
    }
    return lines;
  }

  beforeEach(async () => {
    await resetTestDatabase();
    bearers.length = 0;
    urls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        bearers.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("{}", {
          status: url.includes("/contents/") ? 404 : 503,
        });
      }),
    );
    directory = mkdtempSync(path.join(tmpdir(), "tb116-push-token-"));
    tokenFile = path.join(directory, "ssr_push_github_token");
    vi.stubEnv("SSR_PUSH_GITHUB_TOKEN_FILE", tokenFile);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("sends the token from the file and reads the file again on the next push", async () => {
    const forest = await createForest();
    await servedCorpus(forest);
    target(forest);
    const first = synthetic();
    const second = synthetic();
    writeFileSync(tokenFile, `${first}\n`, { mode: 0o400 });
    const lines = captureConsole();

    // The stubbed ref read fails: the push throws after the reads.
    await expect(pushChangeset(forest.workspace.id, "m")).rejects.toThrow(
      "GitHub ref: HTTP 503",
    );
    expect(bearers.length).toBeGreaterThan(0);
    expect(new Set(bearers)).toEqual(new Set([`Bearer ${first}`]));
    for (const url of urls) {
      expect(url).toContain("/repos/acme/product-a/");
    }

    // A rotated token takes effect on the next push, with no restart.
    rmSync(tokenFile);
    writeFileSync(tokenFile, `${second}\n`, { mode: 0o400 });
    bearers.length = 0;
    expect((await runNightlySsrPush()).degraded).toBe(true);
    expect(new Set(bearers)).toEqual(new Set([`Bearer ${second}`]));

    // No log line carries either token.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(first);
      expect(line).not.toContain(second);
    }
  });

  it("keeps push-back off without the file: one log line, no GitHub call, the old variable ignored", async () => {
    const forest = await createForest();
    await servedCorpus(forest);
    target(forest);
    const legacy = synthetic();
    vi.stubEnv("SSR_PUSH_GITHUB_TOKEN", legacy);
    const lines = captureConsole();

    expect(await runNightlySsrPush()).toEqual({});
    expect(lines).toEqual([
      `SSR push-back skipped: no GitHub token: ${tokenFile} could not be read (ENOENT); SSR_PUSH_GITHUB_TOKEN is ignored since TB-116, put the token into the file`,
    ]);
    expect(await pushChangeset(forest.workspace.id, "m")).toMatchObject({
      pushed: false,
      reason: "not_configured",
    });
    expect(urls).toEqual([]);
  });

  it("keeps push-back off with an empty file", async () => {
    const forest = await createForest();
    await servedCorpus(forest);
    target(forest);
    writeFileSync(tokenFile, " \n", { mode: 0o400 });
    const lines = captureConsole();

    expect(await runNightlySsrPush()).toEqual({});
    expect(lines).toEqual([
      `SSR push-back skipped: no GitHub token: ${tokenFile} is empty`,
    ]);
    expect(urls).toEqual([]);
  });
});
