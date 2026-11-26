import { readFileSync, statSync } from "node:fs";

// TB-116: the GitHub token of push-back comes from a secret file only
// (N-007): SSR_PUSH_GITHUB_TOKEN_FILE, on the VPS
// /run/tb-secrets/ssr_push_github_token. The file is read on every push, so a
// token the owner delivers or rotates needs no restart. No variable, no file,
// an unreadable or an empty file: push-back stays off and `reason` says why.
// `reason` names the path and the error code, never the token.
// A token is one line of visible ASCII, at most 255 characters. Anything else
// (a second line, CR, NUL, a space inside) is refused here: fetch would throw
// with the whole Authorization value in the error text, and the nightly job
// logs that error (Claude lens on #239, B1).
// SE-204: the default reader checks the path with stat before it reads. A
// path that is not a regular file (a directory, a FIFO, a device) or a file
// over MAX_FILE_BYTES is refused without a read, so a wrong file costs no
// memory on every push and a FIFO does not block the event loop.
export type PushToken =
  | { token: string; reason?: undefined }
  | { token?: undefined; reason: string };

export type PushTokenOptions = {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to readTokenFile: stat, then readFileSync(path, "utf8"). */
  readFile?: (path: string) => string;
};

const LEGACY = "SSR_PUSH_GITHUB_TOKEN";
const TOKEN_LINE = /^[\x21-\x7e]{1,255}$/;
/** A token line, a line break and spaces fit with a wide margin. */
export const MAX_FILE_BYTES = 4096;

/** The file is there, but the reader does not read it. */
class TokenFileRefused extends Error {}

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
    raw = (options.readFile ?? readTokenFile)(path);
  } catch (error) {
    if (error instanceof TokenFileRefused) {
      return { reason: `${path} ${error.message}${legacy}` };
    }
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    return { reason: `${path} could not be read (${code})${legacy}` };
  }
  const token = raw.trim();
  if (!token) return { reason: `${path} is empty${legacy}` };
  if (!TOKEN_LINE.test(token)) {
    return {
      reason: `${path} is not one token line (a space, a line break or a control character inside, or over 255 characters)${legacy}`,
    };
  }
  return { token };
}

function readTokenFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new TokenFileRefused("is not a regular file");
  if (stat.size > MAX_FILE_BYTES) {
    throw new TokenFileRefused(`is over ${MAX_FILE_BYTES} bytes`);
  }
  return readFileSync(path, "utf8");
}
