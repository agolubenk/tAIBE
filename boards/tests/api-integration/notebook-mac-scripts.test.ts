import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { auth } from "../../apps/api/src/auth";
import { createApp } from "../../apps/api/src/index";
import { resetEmbedQueueForTests } from "../../apps/api/src/notebook/embed/embed-queue";
import {
  putSourceBody,
  SOURCE_BODY_BYTES,
} from "../../apps/api/src/notebook/routes/schema";
import { serve } from "../../apps/api/node_modules/@hono/node-server";
import {
  BODY_BYTES_MAX,
  listAll,
  REF_MAX,
} from "../../deploy/vps/mac/notebook-sync.mjs";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const run = promisify(execFile);
const MAC = resolve(__dirname, "../../deploy/vps/mac");
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
const writeFiles = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

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

  // The sync lists tracked files only, so the fixtures are committed.
  async function setup(config: Record<string, unknown> = {}) {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });
    const { key } = await auth.api.createApiKey({
      body: { userId: user.id, name: "Notebook worker" },
    });
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFiles(repo, {
      "docs/forest.md": "# Лес\n\n## Аренда\n\nАренда истекает через час.",
      "CLAUDE.md": "# Карточка\n\nРоль и гейт.",
      ".claude/skills/review/SKILL.md": "# Ревью\n\nОдин ревьюер.",
      ".claude/skills/review/run.sh": "echo not a document\n",
      "docs/plans/BACKLOG.md": "# Снимок\n\nстарое",
      "docs/plans/archive/old.md": "# Архив\n\nстарое",
      "docs/private/notes.md": "# Личное\n\nне выгружать",
      ".gitignore": "docs/private/\n",
    });
    await git(repo, "init", "-q");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "fixtures");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        workspaceId: workspace.id,
        repoRoot: repo,
        baseUrl: `http://127.0.0.1:${port(api)}`,
        ollamaUrl: `http://127.0.0.1:${port(ollama)}`,
        git: "git",
        ...config,
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

  it("syncs only the listed, tracked documents and prunes a deleted one", async () => {
    const { repo, node, sources } = await setup();
    // a draft git does not know stays on the Mac
    writeFileSync(join(repo, "docs/draft.md"), "# Черновик\n\nне выгружать");

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

    await git(repo, "rm", "-q", "CLAUDE.md");
    const third = await node("notebook-sync.mjs");
    expect(third.stdout).toContain(
      "2 files, uploaded 0, unchanged 2, skipped 0, pruned 1",
    );
  });

  it("keeps documents moved to the product home under their old refs and stops on a broken link", async () => {
    const { repo, node, sources } = await setup();
    const spec = "# Спека досок\n\nКолонки и карточки.";
    writeFiles(repo, { "t-boards/spec.md": spec });
    await git(repo, "add", "t-boards/spec.md");
    await git(repo, "commit", "-q", "-m", "spec");
    const before = await node("notebook-sync.mjs");
    expect(before.stdout).toContain("4 files, uploaded 4");

    // The split: the document moves to the product home, the host keeps a link.
    await git(repo, "rm", "-q", "t-boards/spec.md");
    const home = join(dir, "tAIBE");
    writeFiles(home, {
      "boards/docs/spec.md": spec,
      "boards/docs/new.md": "# Новое\n\nТолько в доме.",
    });
    await git(home, "init", "-q");
    await git(home, "add", "-A");
    mkdirSync(join(repo, "t-boards"), { recursive: true });
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

    // the host's rule and its review skill (SKILL.md, run.sh), the home's nerve
    const dry = await node("ssr-sync.mjs", "--dry-run");
    expect(dry.stdout).toContain("4 corpus files");

    rmSync(home, { recursive: true, force: true });
    const broken = await node("ssr-sync.mjs", "--dry-run").then(
      () => null,
      (error: { stderr: string }) => error,
    );
    expect(broken?.stderr).toContain("SSR sync stopped, nothing sent");
  });

  it("adds agents, memory chunks, nested docs and the home's way of working, without mirrors (TB-66)", async () => {
    const home = join(dir, "tAIBE");
    const { repo, node, sources } = await setup({
      extraRoots: [home],
      evalRefs: "new",
    });
    // 5 + 201 + 201 + 123 = 530 characters, past the server's 512
    const longRef = `docs/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(120)}.md`;
    writeFiles(repo, {
      ".claude/agents/scout.md": "# Разведчик\n\nДешёвая разведка.",
      ".claude/memory/chunks/process/review.md":
        "# Три линзы\n\nНе меньше трёх.",
      "apps/web/docs/guide.md": "# Гайд веба\n\nВложенные доки.",
      [longRef]: "# Длинный путь\n\nСервер не примет ref.",
      // mirrors generated from .claude/ and dependencies stay out
      ".continue/CLAUDE.md": "# Зеркало\n",
      ".agents/skills/review/docs/notes.md": "# Зеркало\n",
      ".windsurf/docs/rules.md": "# Зеркало\n",
      "packages/ui/node_modules/lib/docs/readme.md": "# Пакет\n",
    });
    await git(repo, "add", "-A");
    writeFiles(home, {
      ".claude/skills/review/SKILL.md": "# Ревью дома\n\nКопия хоста.",
      ".claude/skills/grill/SKILL.md": "# Допрос задачи\n\nВопросы.",
      ".claude/agents/planner.md": "# Планировщик\n\nПлан.",
      ".claude/memory/chunks/process/handoff.md": "# Эстафета\n\nПреемник.",
      "boards/docs/impl/impl-b3-notebook.md": "# Блокнот\n\nСрезы.",
      "docs/guide.md": "# Гайд\n\nКак работаем.",
      "docs/plans/BACKLOG.md": "# Снимок\n",
      "docs/plans/archive/old.md": "# Архив\n",
      "process/README.md": "# Процесс\n\nПередача.",
    });
    await git(home, "init", "-q");
    await git(home, "add", "-A");
    writeFiles(home, { "process/draft.md": "# Черновик\n" });

    const first = await node("notebook-sync.mjs");
    expect(first.stdout).toContain(
      "13 files, uploaded 12, unchanged 0, skipped 1, pruned 0",
    );
    expect(first.stderr).toContain("ref longer than 512");
    const listed = (await sources()).sources;
    expect(listed.map((s) => s.ref).sort()).toEqual([
      ".claude/agents/planner.md",
      ".claude/agents/scout.md",
      ".claude/memory/chunks/process/handoff.md",
      ".claude/memory/chunks/process/review.md",
      ".claude/skills/grill/SKILL.md",
      ".claude/skills/review/SKILL.md",
      "CLAUDE.md",
      "apps/web/docs/guide.md",
      "boards/docs/impl/impl-b3-notebook.md",
      "docs/forest.md",
      "docs/guide.md",
      "process/README.md",
    ]);
    // the host wins on a clash
    expect(
      listed.find((s) => s.ref === ".claude/skills/review/SKILL.md")?.title,
    ).toBe("Ревью");

    // evalRefs "old" moves only the HOME_DOCS prefixes back
    const old = listAll({
      repoRoot: repo,
      extraRoots: [home],
      evalRefs: "old",
      git: "git",
    });
    expect(old.has("t-boards/impl/impl-b3-notebook.md")).toBe(true);
    expect(old.has("boards/docs/impl/impl-b3-notebook.md")).toBe(false);
    expect(old.has("process/README.md")).toBe(true);

    // the skip limits are the server's
    expect(REF_MAX).toBe(putSourceBody.shape.ref.maxLength);
    expect(BODY_BYTES_MAX).toBe(SOURCE_BODY_BYTES);
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
