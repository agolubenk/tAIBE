// Shared by the Mac notebook worker and sync: config from
// ~/.t-boards-notebook (or $T_BOARDS_NOTEBOOK_HOME) and calls to the
// notebook API with the workspace API key. The key is never printed.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function loadConfig() {
  const home =
    process.env.T_BOARDS_NOTEBOOK_HOME || join(homedir(), ".t-boards-notebook");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const apiKey = readFileSync(join(home, "api_key"), "utf8").trim();
  if (!config.workspaceId || !apiKey) {
    throw new Error(`${home}: config.json needs workspaceId, api_key a key`);
  }
  return {
    home,
    baseUrl: (config.baseUrl || "https://d4dev.admin.hrhelper.space").replace(
      /\/+$/,
      "",
    ),
    workspaceId: config.workspaceId,
    ollamaUrl: (config.ollamaUrl || "http://127.0.0.1:11434").replace(
      /\/+$/,
      "",
    ),
    repoRoot: config.repoRoot,
    extraRoots: config.extraRoots,
    git: config.git || "git",
    apiKey,
  };
}

export async function notebookApi(
  config,
  method,
  path,
  body,
  timeoutMs = 30_000,
) {
  const url = `${config.baseUrl}/api/notebook/${encodeURIComponent(config.workspaceId)}${path}`;
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
      `${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

export const stamp = () => new Date().toISOString();

// The product home (tAIBE) beside a host checkout. After the split
// (docs/ops/split-hr-taibe.md) the host keeps t-boards/app as a link into
// <tAIBE>/boards, and the documents that used to live in the host's
// t-boards/ and supertick-eval/ are read from there under their old refs, so
// nothing on the server is pruned or archived. config.extraRoots (a list of
// folders) wins over the link. A link that leads nowhere is an error, not
// "no extra root": the caller must not prune or archive what it cannot read.
export function extraRoots(config) {
  if (Array.isArray(config.extraRoots)) {
    const roots = config.extraRoots.filter(Boolean);
    const missing = roots.find((root) => !existsSync(join(root, ".git")));
    return missing
      ? { roots: [], error: `extra root ${missing} is not a git checkout` }
      : { roots, error: null };
  }
  if (!config.repoRoot) return { roots: [], error: null };
  const link = join(config.repoRoot, "t-boards", "app");
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return { roots: [], error: null }; // a plain host, or the product home itself
  }
  if (!stat.isSymbolicLink()) return { roots: [], error: null };
  try {
    const boards = realpathSync(link);
    const home = dirname(boards);
    if (basename(boards) === "boards" && existsSync(join(home, ".git"))) {
      return { roots: [home], error: null };
    }
    return {
      roots: [],
      error: `${link} leads to ${boards}, not <tAIBE>/boards`,
    };
  } catch {
    return { roots: [], error: `${link} leads nowhere` };
  }
}

// Refs of files under `prefix` in another checkout, renamed to the old prefix.
export function mapRef(path, map) {
  for (const [from, to] of Object.entries(map)) {
    if (path.startsWith(from)) return to + path.slice(from.length);
  }
  return null;
}
