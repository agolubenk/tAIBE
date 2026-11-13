import { readFileSync } from "node:fs";

type Env = Record<string, string | undefined>;

const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

// A missing file is a setup state (push-back off), not an error; any other
// read failure is said once per call, without the path's content.
function readSecret(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    if (code !== "ENOENT") {
      console.warn(
        `SSR push-back: SSR_PUSH_GITHUB_TOKEN_FILE is not readable (${code}), push-back off`,
      );
    }
    return undefined;
  }
}

/**
 * The GitHub token of push-back (TB-116). The VPS kit gives it as the secret
 * file named by SSR_PUSH_GITHUB_TOKEN_FILE (compose.yml, /run/tb-secrets,
 * 0400, owner 1001), read on every call: a delivered or rotated token needs
 * no restart. SSR_PUSH_GITHUB_TOKEN stays for a dev run. No variable, no file
 * or an empty file — undefined, push-back off.
 */
export function pushToken(
  env: Env = process.env,
  read: (path: string) => string | undefined = readSecret,
): string | undefined {
  const direct = nonEmpty(env.SSR_PUSH_GITHUB_TOKEN);
  if (direct) return direct;
  const path = nonEmpty(env.SSR_PUSH_GITHUB_TOKEN_FILE);
  return path ? nonEmpty(read(path)) : undefined;
}
