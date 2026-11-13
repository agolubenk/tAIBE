import { readFileSync } from "node:fs";

// TB-116: the GitHub token of push-back comes from a secret file only
// (N-007): SSR_PUSH_GITHUB_TOKEN_FILE, on the VPS
// /run/tb-secrets/ssr_push_github_token. The file is read on every push, so a
// token the owner delivers or rotates needs no restart. No variable, no file,
// an unreadable or an empty file: push-back stays off and `reason` says why.
// `reason` names the path and the error code, never the token.
export type PushToken =
  | { token: string; reason?: undefined }
  | { token?: undefined; reason: string };

export type PushTokenOptions = {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to readFileSync(path, "utf8"). */
  readFile?: (path: string) => string;
};

const LEGACY = "SSR_PUSH_GITHUB_TOKEN";

export function resolvePushToken(options: PushTokenOptions = {}): PushToken {
  const env = options.env ?? process.env;
  const path = env.SSR_PUSH_GITHUB_TOKEN_FILE?.trim();
  // The old plain variable is ignored: an environment string shows up in
  // `docker inspect` and in /proc/<pid>/environ.
  const legacy = env[LEGACY]?.trim()
    ? `; ${LEGACY} is ignored since TB-116, put the token into the file`
    : "";
  if (!path) {
    return { reason: `SSR_PUSH_GITHUB_TOKEN_FILE is not set${legacy}` };
  }
  let raw: string;
  try {
    raw = (options.readFile ?? readUtf8)(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    return { reason: `${path} could not be read (${code})${legacy}` };
  }
  const token = raw.trim();
  if (!token) return { reason: `${path} is empty${legacy}` };
  return { token };
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}
