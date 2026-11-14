#!/usr/bin/env node
// Uploads the SSR corpus (skills, rules, agents, genomes, prompts, nerve,
// ai-council config, product prompts) to tAI-Boards: files whose sha256 is
// new to the server ride along, everything else travels as a manifest entry.
// The corpus allowlist lives on the server too — a path outside it aborts
// the whole sync. Reads git-tracked files at HEAD only (spec RU-4), never
// the working tree, so local scratch files cannot leak into snapshots.
//   node ssr-sync.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extraRoots, loadConfig, mapRef } from "./notebook-client.mjs";

const PATHSPECS = [
  // the server corpus (apps/api/src/ssr/corpus.ts) takes skills as folders
  // only — .claude/skills/<name>/<file> — so flat *.md at the skills root
  // stay out; a sync that sends them aborts the whole push (RU-9).
  ":(glob).claude/skills/*/**",
  ":(glob).claude/rules/*.md",
  ":(glob).claude/agents/*.md",
  ":(glob)supertick-eval/pipeline/genome/**",
  ":(glob)supertick-eval/prompts/**",
  ":(glob)supertick-eval/nerve/**",
  // the product home (tAIBE) keeps the eval tree at eval/ (apps/api/src/ssr/corpus.ts reads both)
  ":(glob)eval/pipeline/genome/**",
  ":(glob)eval/prompts/**",
  ":(glob)eval/nerve/**",
  ":(glob)infra/ai-council/config.toml",
  ":(glob)apps/backend/src/modules/ai/prompts/**",
  ":(glob)apps/backend/src/modules/ai/prompt-templates/**",
  ":(exclude,glob)**/node_modules/**",
];

const FILE_MAX = 600_000;

// The most shas that one known-shas request takes (apps/api/src/ssr/routes/index.ts).
export const KNOWN_SHAS_MAX = 1000;

// TB-95. Asks the server which shas it already stores, in requests of at most
// `size` distinct shas, one after another; `ask(shas)` answers `{ shas }`.
export async function knownShasInBatches(ask, shas, size = KNOWN_SHAS_MAX) {
  const unique = [...new Set(shas)];
  const known = new Set();
  for (let start = 0; start < unique.length; start += size) {
    const answer = await ask(unique.slice(start, start + size));
    for (const sha of answer?.shas ?? []) known.add(sha);
  }
  return known;
}

// The eval tree the host lost at the split, read from the product home at its
// HEAD under the old supertick-eval/ paths: the server archives whatever a
// sync leaves out, so these keep their entities instead of being archived.
const HOME_CORPUS = {
  "eval/pipeline/genome/": "supertick-eval/pipeline/genome/",
  "eval/prompts/": "supertick-eval/prompts/",
  "eval/nerve/": "supertick-eval/nerve/",
};

function listCorpus(repoRoot, git = "git", pathspecs = PATHSPECS) {
  const out = execFileSync(
    git,
    ["ls-files", "--cached", "-z", "--", ...pathspecs],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return out.toString("utf8").split("\0").filter(Boolean).sort();
}

function headCommit(repoRoot, git = "git") {
  return execFileSync(git, ["rev-parse", "HEAD"], { cwd: repoRoot })
    .toString("utf8")
    .trim();
}

function fileAtHead(repoRoot, path, git = "git") {
  return execFileSync(git, ["show", `HEAD:${path}`], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const stamp = (message) =>
  console.log(`${new Date().toISOString()} ${message}`);

async function ssrApi(config, path, method, body, timeoutMs = 60_000) {
  const url = `${config.baseUrl}/api/ssr/${encodeURIComponent(config.workspaceId)}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "x-api-key": config.apiKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const config = await loadConfig();
  const repoRoot = config.repoRoot ?? process.cwd();
  const commitSha = headCommit(repoRoot, config.git);
  // path → [checkout, path there]: the host first, then the product home under old paths.
  const sources = new Map(
    listCorpus(repoRoot, config.git).map((path) => [path, [repoRoot, path]]),
  );
  const { roots, error } = extraRoots(config);
  if (error) throw new Error(`${error}: SSR sync stopped, nothing sent`);
  const homeSpecs = Object.keys(HOME_CORPUS).map(
    (prefix) => `:(glob)${prefix}**`,
  );
  for (const root of roots) {
    for (const path of listCorpus(root, config.git, homeSpecs)) {
      // config.evalRefs "new": native eval/… paths — D-008 "close the old
      // records"; "old" (default): the pre-split supertick-eval/… refs.
      const ref = config.evalRefs === "new" ? path : mapRef(path, HOME_CORPUS);
      if (ref && !sources.has(ref)) sources.set(ref, [root, path]);
    }
  }
  const paths = [...sources.keys()].sort();

  const files = [];
  for (const path of paths) {
    const [root, rel] = sources.get(path);
    const content = fileAtHead(root, rel, config.git);
    if (content.byteLength > FILE_MAX) {
      stamp(`skip ${path}: larger than ${FILE_MAX} bytes`);
      continue;
    }
    files.push({
      path,
      sha256: sha256(content),
      content: content.toString("utf8"),
    });
  }

  // Ask which shas the server already stores so only new content uploads.
  const known = await knownShasInBatches(
    (shas) => ssrApi(config, "/known-shas", "POST", { shas }),
    files.map((file) => file.sha256),
  );
  const payload = {
    commitSha,
    files: files.map((file) =>
      known.has(file.sha256)
        ? { path: file.path, sha256: file.sha256 }
        : { path: file.path, sha256: file.sha256, content: file.content },
    ),
  };

  stamp(
    `${dryRun ? "[dry-run] " : ""}${files.length} corpus files at ${commitSha.slice(0, 10)}, ${payload.files.filter((file) => file.content).length} to upload`,
  );
  if (dryRun) return;

  const result = await ssrApi(config, "/sync", "POST", payload);
  stamp(
    `synced: ${result.created.length} new (drafts), ${result.bumped.length} bumped, ${result.unchanged} unchanged, ${result.archived.length} archived`,
  );
}

// Runs only as a script, not on import (tests import knownShasInBatches). The
// realpath keeps a start through a symlink working: HR's t-boards/app leads here.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
