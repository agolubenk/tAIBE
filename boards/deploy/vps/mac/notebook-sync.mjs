// Uploads the repo's documents to the t-boards notebook: only files whose
// sha256 differs from the server's copy, then removes sources whose file is
// gone. Only git-tracked files are listed: untracked and ignored local files
// stay home.
//   node notebook-sync.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extraRoots,
  loadConfig,
  mapRef,
  notebookApi,
  stamp,
} from "./notebook-client.mjs";

const KIND = "repo-doc";
const TEXT_MAX = 500_000;
// The server's limits for PUT /sources (apps/api/src/notebook/routes/schema.ts):
// a file past them is skipped here, not sent, since one 400/413 aborts the run.
export const REF_MAX = 512;
export const BODY_BYTES_MAX = 2 * 1024 * 1024;
// A listing that lost more than half the corpus is a broken checkout or a
// failed git call, not a cleanup: prune refuses it.
const PRUNE_FLOOR = 0.5;

// Snapshots, mirrors generated from .claude/ (.continue/, .agents/,
// .windsurf/) and dependencies stay out of every root.
const EXCLUDES = [
  ":(exclude,glob)docs/plans/archive/**",
  ":(exclude)docs/plans/BACKLOG.md",
  ":(exclude,glob)**/.continue/**",
  ":(exclude,glob)**/.agents/**",
  ":(exclude,glob)**/.windsurf/**",
  ":(exclude,glob)**/node_modules/**",
];

export const PATHSPECS = [
  // docs/ and docs folders deeper in the tree (apps/frontend/docs, …)
  ":(glob)**/docs/**/*.md",
  ":(glob)**/CLAUDE.md",
  ":(glob).claude/rules/*.md",
  ":(glob).claude/skills/**/*.md",
  ":(glob).claude/agents/*.md",
  ":(glob).claude/memory/chunks/**/*.md",
  ":(glob)t-boards/*.md",
  ":(glob)supertick-eval/pipeline/*.md",
  // the same documents in the product home (tAIBE): boards/docs, eval/
  ":(glob)boards/docs/*.md",
  ":(glob)eval/pipeline/*.md",
  ...EXCLUDES,
];

// Documents the host lost at the split, read from the product home under their
// old refs (config.evalRefs "old").
export const HOME_DOCS = {
  "boards/docs/": "t-boards/",
  "eval/pipeline/": "supertick-eval/pipeline/",
};

// What an extra root (the product home, tAIBE) contributes: the documents of
// HOME_DOCS and its own copy of the way of working — skills, agents, memory,
// docs, process (TB-66).
export const HOME_PATHSPECS = [
  ":(glob)boards/docs/*.md",
  ":(glob)boards/docs/impl/**/*.md",
  ":(glob)eval/pipeline/*.md",
  ":(glob).claude/skills/**/*.md",
  ":(glob).claude/agents/*.md",
  ":(glob).claude/memory/chunks/**/*.md",
  ":(glob)docs/**/*.md",
  ":(glob)process/**/*.md",
  ...EXCLUDES,
];

// Tracked files only (the index): a local draft or scratch file that git does
// not know is never sent, so nothing of the working tree beyond the tracked
// documents leaves the Mac.
export function listDocuments(repoRoot, git = "git", pathspecs = PATHSPECS) {
  const out = execFileSync(
    git,
    ["ls-files", "--cached", "-z", "--", ...pathspecs],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return [...new Set(out.toString("utf8").split("\0").filter(Boolean))].sort();
}

// ref → file on disk: the host's own documents, then the product home's. The
// host wins on a clash. config.evalRefs "new" keeps the home's native paths
// (D-008); "old" renames HOME_DOCS prefixes back (boards/docs/ → t-boards/).
// Throws when an extra root cannot be read, so nothing is pruned on a partial
// listing.
export function listAll(config) {
  const entries = new Map();
  for (const path of listDocuments(config.repoRoot, config.git)) {
    entries.set(path, join(config.repoRoot, path));
  }
  const { roots, error } = extraRoots(config);
  if (error)
    throw new Error(`${error}: sync stopped, nothing uploaded or pruned`);
  for (const root of roots) {
    for (const path of listDocuments(root, config.git, HOME_PATHSPECS)) {
      const ref =
        config.evalRefs === "new" ? path : (mapRef(path, HOME_DOCS) ?? path);
      if (!entries.has(ref)) entries.set(ref, join(root, path));
    }
  }
  return new Map([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

export function titleOf(path, text) {
  const heading = text.match(/^#\s+(.+?)\s*#*\s*$/m);
  return (heading?.[1] || basename(path)).slice(0, 300);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Why the server would refuse this upload, or null. Postgres text cannot hold
// NUL, so such a file would fail the insert with a 500.
export function uploadProblem(ref, text) {
  if (ref.length > REF_MAX) return `ref longer than ${REF_MAX}`;
  if (text.length > TEXT_MAX) return `${text.length} chars > ${TEXT_MAX}`;
  if (text.includes("\0")) return "NUL byte in text";
  const body = JSON.stringify({
    kind: KIND,
    ref,
    title: titleOf(ref, text),
    text,
  });
  if (Buffer.byteLength(body) > BODY_BYTES_MAX) {
    return `body over ${BODY_BYTES_MAX} bytes`;
  }
  return null;
}

async function main() {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  if (!config.repoRoot) throw new Error("config.json needs repoRoot");
  const entries = listAll(config);
  const paths = [...entries.keys()];
  const server = await notebookApi(config, "GET", "/sources");
  const known = new Map(
    server.sources
      .filter((source) => source.kind === KIND)
      .map((source) => [source.ref, source.contentSha256]),
  );

  const keep = [];
  let uploaded = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(entries.get(path), "utf8");
    } catch {
      skipped++;
      continue;
    }
    const problem = uploadProblem(path, text);
    if (problem) {
      console.warn(`${stamp()} skip ${path.slice(0, 200)}: ${problem}`);
      skipped++;
      continue;
    }
    keep.push(path);
    if (known.get(path) === sha256(text)) {
      unchanged++;
      continue;
    }
    if (!dryRun) {
      await notebookApi(config, "PUT", "/sources", {
        kind: KIND,
        ref: path,
        title: titleOf(path, text),
        text,
      });
    }
    uploaded++;
  }

  let pruned = 0;
  const keepSet = new Set(keep);
  const gone = [...known.keys()].filter((ref) => !keepSet.has(ref));
  if (dryRun && gone.length) {
    console.log(
      `${stamp()} would prune ${gone.length}: ${gone.slice(0, 20).join(", ")}${gone.length > 20 ? ", …" : ""}`,
    );
  }
  if (known.size && keep.length < known.size * PRUNE_FLOOR) {
    console.error(
      `${stamp()} prune refused: ${keep.length} local files against ${known.size} on the server`,
    );
  } else if (!dryRun) {
    ({ deleted: pruned } = await notebookApi(config, "POST", "/sources/prune", {
      kind: KIND,
      keep,
    }));
  }
  console.log(
    `${stamp()} sync${dryRun ? " (dry run)" : ""}: ${paths.length} files, uploaded ${uploaded}, unchanged ${unchanged}, skipped ${skipped}, pruned ${pruned}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`${stamp()} ${error.message}`);
    process.exit(1);
  });
}
