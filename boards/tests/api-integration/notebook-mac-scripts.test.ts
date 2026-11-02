import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import { createApp } from "../../apps/api/src/index";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import { serve } from "../../apps/api/node_modules/@hono/node-server";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const run = promisify(execFile);
const MAC = resolve(__dirname, "../../deploy/vps/mac");

// The Mac scripts against a real API over HTTP and a stand-in for Ollama:
// synthetic files in a throwaway git repo, nothing from the real checkout.
describe("API integration: notebook Mac scripts", () => {
  let dir: string;
  let api: ReturnType<typeof serve>;
  let ollama: Server;
  const embedInputs: string[] = [];

  const port = (server: { address(): AddressInfo | string | null }) =>
    (server.address() as AddressInfo).port;

  beforeEach(async () => {
    await resetTestDatabase();
    embedInputs.length = 0;
    dir = mkdtempSync(join(tmpdir(), "t-boards-notebook-"));

    api = serve({
      fetch: createApp().app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    if (!api.listening) await once(api, "listening");
    ollama = createServer((req, res) => {
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => {
        const { input } = JSON.parse(body) as { input: string[] };
        embedInputs.push(...input);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ embeddings: input.map((_, i) => [1, i]) }));
      });
    });
    ollama.listen(0, "127.0.0.1");
    await once(ollama, "listening");
  });

  afterEach(async () => {
    resetEmbedQueueForTests();
    await new Promise((done) => api.close(done));
    await new Promise((done) => ollama.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const { key } = await auth.api.createApiKey({
      body: { userId: user.id, name: "Notebook worker" },
    });
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    for (const sub of [
      "docs/plans/archive",
      "docs/private",
      ".claude/skills/review",
      "home",
    ]) {
      mkdirSync(join(sub === "home" ? dir : repo, sub), { recursive: true });
    }
    const files: Record<string, string> = {
      "docs/forest.md": "# Лес\n\n## Аренда\n\nАренда истекает через час.",
      "CLAUDE.md": "# Карточка\n\nРоль и гейт.",
      ".claude/skills/review/SKILL.md": "# Ревью\n\nОдин ревьюер.",
      ".claude/skills/review/run.sh": "echo not a document\n",
      "docs/plans/BACKLOG.md": "# Снимок\n\nстарое",
      "docs/plans/archive/old.md": "# Архив\n\nстарое",
      "docs/private/notes.md": "# Личное\n\nне выгружать",
      ".gitignore": "docs/private/\n",
    };
    for (const [path, text] of Object.entries(files)) {
      writeFileSync(join(repo, path), text);
    }
    await run("git", ["init", "-q"], { cwd: repo });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        workspaceId: workspace.id,
        repoRoot: repo,
        baseUrl: `http://127.0.0.1:${port(api)}`,
        ollamaUrl: `http://127.0.0.1:${port(ollama)}`,
        git: "git",
      }),
    );
    writeFileSync(join(home, "api_key"), `${key}\n`);
    const node = (script: string, ...args: string[]) =>
      run(process.execPath, [join(MAC, script), ...args], {
        env: { ...process.env, T_BOARDS_NOTEBOOK_HOME: home },
      });
    const sources = async () => {
      const response = await fetch(
        `http://127.0.0.1:${port(api)}/api/notebook/${workspace.id}/sources`,
        { headers: { "x-api-key": key } },
      );
      return (await response.json()) as {
        sources: { ref: string; chunks: number; embedded: number }[];
      };
    };
    return { repo, node, sources };
  }

  it("syncs only the listed, unignored documents and prunes a deleted one", async () => {
    const { repo, node, sources } = await setup();

    const first = await node("notebook-sync.mjs");
    expect(first.stdout).toContain(
      "3 files, uploaded 3, unchanged 0, skipped 0, pruned 0",
    );
    expect((await sources()).sources.map((s) => s.ref).sort()).toEqual([
      ".claude/skills/review/SKILL.md",
      "CLAUDE.md",
      "docs/forest.md",
    ]);

    const second = await node("notebook-sync.mjs");
    expect(second.stdout).toContain("uploaded 0, unchanged 3");

    unlinkSync(join(repo, "CLAUDE.md"));
    const third = await node("notebook-sync.mjs");
    expect(third.stdout).toContain(
      "2 files, uploaded 0, unchanged 2, skipped 0, pruned 1",
    );
  });

  it("keeps documents moved to the product home under their old refs and stops on a broken link", async () => {
    const { repo, node, sources } = await setup();
    const spec = "# Спека досок\n\nКолонки и карточки.";
    mkdirSync(join(repo, "t-boards"), { recursive: true });
    writeFileSync(join(repo, "t-boards/spec.md"), spec);
    const before = await node("notebook-sync.mjs");
    expect(before.stdout).toContain("4 files, uploaded 4");

    // The split: the document moves to the product home, the host keeps a link.
    unlinkSync(join(repo, "t-boards/spec.md"));
    const home = join(dir, "tAIBE");
    mkdirSync(join(home, "boards/docs"), { recursive: true });
    writeFileSync(join(home, "boards/docs/spec.md"), spec);
    writeFileSync(
      join(home, "boards/docs/new.md"),
      "# Новое\n\nТолько в доме.",
    );
    await run("git", ["init", "-q"], { cwd: home });
    symlinkSync(join(home, "boards"), join(repo, "t-boards/app"));

    const dry = await node("notebook-sync.mjs", "--dry-run");
    expect(dry.stdout).not.toContain("would prune");
    const after = await node("notebook-sync.mjs");
    expect(after.stdout).toContain(
      "5 files, uploaded 1, unchanged 4, skipped 0, pruned 0",
    );
    const refs = (await sources()).sources.map((s) => s.ref);
    expect(refs).toContain("t-boards/spec.md");
    expect(refs).toContain("t-boards/new.md");

    // A link that leads nowhere stops the sync before anything is pruned.
    rmSync(home, { recursive: true, force: true });
    const broken = await node("notebook-sync.mjs").then(
      () => null,
      (error: { stderr: string }) => error,
    );
    expect(broken?.stderr).toContain("leads nowhere");
    expect((await sources()).sources.map((s) => s.ref)).toContain(
      "t-boards/spec.md",
    );
  });

  it("sends the SSR corpus of the product home under the old supertick-eval paths", async () => {
    const { repo, node } = await setup();
    const git = (cwd: string, ...args: string[]) =>
      run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd,
      });
    mkdirSync(join(repo, ".claude/rules"), { recursive: true });
    writeFileSync(join(repo, ".claude/rules/01-base.md"), "# Правила\n");
    await git(repo, "add", ".claude/rules/01-base.md");
    await git(repo, "commit", "-q", "-m", "host");
    const home = join(dir, "tAIBE");
    mkdirSync(join(home, "eval/nerve"), { recursive: true });
    mkdirSync(join(home, "boards"), { recursive: true });
    writeFileSync(join(home, "eval/nerve/README.md"), "# Нерв\n");
    writeFileSync(join(home, "boards/README.md"), "# Доски\n");
    await git(home, "init", "-q");
    await git(home, "add", "-A");
    await git(home, "commit", "-q", "-m", "home");
    mkdirSync(join(repo, "t-boards"), { recursive: true });
    symlinkSync(join(home, "boards"), join(repo, "t-boards/app"));

    const dry = await node("ssr-sync.mjs", "--dry-run");
    expect(dry.stdout).toContain("2 corpus files");

    rmSync(home, { recursive: true, force: true });
    const broken = await node("ssr-sync.mjs", "--dry-run").then(
      () => null,
      (error: { stderr: string }) => error,
    );
    expect(broken?.stderr).toContain("SSR sync stopped, nothing sent");
  });

  it("embeds the uploaded chunks with nomic task prefixes", async () => {
    const { node, sources } = await setup();
    await node("notebook-sync.mjs");

    const round = await node("notebook-worker.mjs", "--once");
    expect(round.stdout).toContain(
      "embedded 3 (0 queries), saved 3, rejected 0",
    );
    expect(embedInputs).toHaveLength(3);
    expect(
      embedInputs.every((text) => text.startsWith("search_document: ")),
    ).toBe(true);
    expect(embedInputs).toContain(
      "search_document: Лес › Аренда\n\nАренда истекает через час.",
    );
    const listed = await sources();
    expect(listed.sources.map((s) => [s.chunks, s.embedded])).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });
});
