import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WORKER_PORT = 3777;
export const DEFAULT_WORKER_HOST = "127.0.0.1";

export type ResolveWorkerUrlOptions = {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to ~/.claude-mem/settings.json. */
  settingsPath?: string;
  /** Defaults to a readFileSync wrapper that returns undefined on any error. */
  readFile?: (path: string) => string | undefined;
};

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readSettings(
  readFile: (path: string) => string | undefined,
  settingsPath: string,
): Record<string, unknown> {
  let raw: string | undefined;
  try {
    raw = readFile(settingsPath);
  } catch {
    return {};
  }
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Resolves the claude-mem worker base URL. Priority:
 * CLAUDE_MEM_WORKER_PORT / CLAUDE_MEM_WORKER_HOST env vars, then the same keys
 * in ~/.claude-mem/settings.json, then defaults (127.0.0.1:3777).
 *
 * The settings file is the only file read; claude-mem.db is never opened
 * (R-040: all data access goes through the worker HTTP API).
 */
export function resolveWorkerUrl(
  options: ResolveWorkerUrlOptions = {},
): string {
  const env = options.env ?? process.env;
  const settingsPath =
    options.settingsPath ?? join(homedir(), ".claude-mem", "settings.json");
  const readFile = options.readFile ?? defaultReadFile;

  const settings = readSettings(readFile, settingsPath);

  // An empty env var counts as unset, so it cannot hide the settings file.
  const portRaw =
    nonEmpty(env.CLAUDE_MEM_WORKER_PORT) ??
    nonEmpty(settings.CLAUDE_MEM_WORKER_PORT);
  const hostRaw =
    nonEmpty(env.CLAUDE_MEM_WORKER_HOST) ??
    nonEmpty(settings.CLAUDE_MEM_WORKER_HOST);

  const port = Number(portRaw);
  const validPort =
    Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : DEFAULT_WORKER_PORT;
  const host = hostRaw ?? DEFAULT_WORKER_HOST;
  return `http://${host}:${validPort}`;
}

export type ResolveProxyTokenOptions = {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to a readFileSync wrapper that returns undefined on any error. */
  readFile?: (path: string) => string | undefined;
};

/**
 * The token of the Mac's read-only memory proxy (OPS-19), from the file named
 * by CLAUDE_MEM_PROXY_TOKEN_FILE. Read on every call, so a delivered or
 * rotated file needs no restart. No variable, no file or an empty file gives
 * undefined: requests go without the header, the proxy's rollout mode.
 */
export function resolveProxyToken(
  options: ResolveProxyTokenOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const path = nonEmpty(env.CLAUDE_MEM_PROXY_TOKEN_FILE);
  if (!path) return undefined;
  return nonEmpty((options.readFile ?? defaultReadFile)(path));
}
