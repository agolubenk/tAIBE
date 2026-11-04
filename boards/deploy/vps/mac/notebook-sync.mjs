// Uploads the repo's documents to the t-boards notebook: only files whose
// sha256 differs from the server's copy, then removes sources whose file is
// gone. The file list honours .gitignore, so ignored local folders stay home.
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
// A listing that lost more than half the corpus is a broken checkout or a
// failed git call, not a cleanup: prune refuses it.
const PRUNE_FLOOR = 0.5;

export const PATHSPECS = [
  ":(glob)docs/**/*.md",
  ":(glob)**/CLAUDE.md",
  ":(glob).claude/rules/*.md",
  ":(glob).claude/skills/**/*.md",
  ":(glob)t-boards/*.md",
  ":(glob)supertick-eval/pipeline/*.md",
  // the same documents in the product home (tAIBE): boards/docs, eval/
  ":(glob)boards/docs/*.md",
  ":(glob)eval/pipeline/*.md",
  ":(exclude,glob)docs/plans/archive/**",
  ":(exclude)docs/plans/BACKLOG.md",
];

// Documents the host lost at the split, read from the product home under their
// old refs (top-level *.md only, as the host patterns were).
export const HOME_DOCS = {
  "boards/docs/": "t-boards/",
  "eval/pipeline/": "supertick-eval/pipeline/",
};

export function listDocuments(repoRoot, git = "git", pathspecs = PATHSPECS) {
  const out = execFileSync(
    git,
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...pathspecs,
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return [...new Set(out.toString("utf8").split("\0").filter(Boolean))].sort();
}

// ref → file on disk: the host's own documents, then the product home's under
// their old refs (the host wins on a clash; config.evalRefs "new" keeps their
// native paths instead — D-008). Throws when an extra root cannot
// be read, so nothing is pruned on a partial listing.
export function listAll(config) {
  const entries = new Map();
  for (const path of listDocuments(config.repoRoot, config.git)) {
    entries.set(path, join(config.repoRoot, path));
  }
  const { roots, error } = extraRoots(config);
  if (error)
    throw new Error(`${error}: sync stopped, nothing uploaded or pruned`);
  const specs = Object.keys(HOME_DOCS).map((prefix) => `:(glob)${prefix}*.md`);
  for (const root of roots) {
    for (const path of listDocuments(root, config.git, specs)) {
      const ref =
        config.evalRefs === "new" ? path : mapRef(path, HOME_DOCS);
      if (ref && !entries.has(ref)) entries.set(ref, join(root, path));
    }
  }
  return new Map([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

export function titleOf(path, text) {
  const heading = text.match(/^#\s+(.+?)\s*#*\s*$/m);
  return (heading?.[1] || basename(path)).slice(0, 300);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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
    if (text.length > TEXT_MAX) {
      console.warn(
        `${stamp()} skip ${path}: ${text.length} chars > ${TEXT_MAX}`,
      );
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
