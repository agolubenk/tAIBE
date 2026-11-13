import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { resolvePushToken } from "../../../apps/api/src/ssr/push-token";

const FILE = "/run/tb-secrets/ssr_push_github_token";
const SYNTHETIC = "ghp_synthetic_tb116_0123456789abcdef";

// TB-116: the push-back token comes from a secret file, read on every call.
describe("resolvePushToken", () => {
  it("reads and trims the file named by SSR_PUSH_GITHUB_TOKEN_FILE", () => {
    const seen: string[] = [];
    const result = resolvePushToken({
      env: { SSR_PUSH_GITHUB_TOKEN_FILE: ` ${FILE} ` },
      readFile: (file) => {
        seen.push(file);
        return `${SYNTHETIC}\r\n`;
      },
    });
    expect(result).toEqual({ token: SYNTHETIC });
    expect(seen).toEqual([FILE]);
  });

  it("is off without the variable, and the plain token variable does not count", () => {
    expect(resolvePushToken({ env: {} })).toEqual({
      reason: "SSR_PUSH_GITHUB_TOKEN_FILE is not set",
    });
    const legacy = resolvePushToken({
      env: {
        SSR_PUSH_GITHUB_TOKEN: SYNTHETIC,
        SSR_PUSH_GITHUB_TOKEN_FILE: " ",
      },
    });
    expect(legacy.token).toBeUndefined();
    expect(legacy.reason).toBe(
      "SSR_PUSH_GITHUB_TOKEN_FILE is not set; SSR_PUSH_GITHUB_TOKEN is ignored since TB-116, put the token into the file",
    );
    expect(legacy.reason).not.toContain(SYNTHETIC);
  });

  it("is off with an unreadable or an empty file and names the path and the code", () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    });
    expect(
      resolvePushToken({
        env: { SSR_PUSH_GITHUB_TOKEN_FILE: FILE },
        readFile: () => {
          throw denied;
        },
      }),
    ).toEqual({ reason: `${FILE} could not be read (EACCES)` });
    expect(
      resolvePushToken({
        env: { SSR_PUSH_GITHUB_TOKEN_FILE: FILE },
        readFile: () => " \n",
      }),
    ).toEqual({ reason: `${FILE} is empty` });
  });
});

describe("resolvePushToken on a real file", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "tb116-token-"));
    file = path.join(directory, "ssr_push_github_token");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads the file on every call, so a rotation needs no restart", () => {
    const env = { SSR_PUSH_GITHUB_TOKEN_FILE: file };
    expect(resolvePushToken({ env }).reason).toBe(
      `${file} could not be read (ENOENT)`,
    );
    writeFileSync(file, `${SYNTHETIC}-a\n`, { mode: 0o400 });
    expect(resolvePushToken({ env })).toEqual({ token: `${SYNTHETIC}-a` });
    rmSync(file);
    writeFileSync(file, `${SYNTHETIC}-b\n`, { mode: 0o400 });
    expect(resolvePushToken({ env })).toEqual({ token: `${SYNTHETIC}-b` });
  });
});

// TB-116: compose passes the app an explicit list, so a variable missing
// there never reaches the container. These pin the deploy wiring.
describe("SSR push-back deploy wiring", () => {
  const vps = path.resolve(__dirname, "../../../deploy/vps");
  const compose = readFileSync(path.join(vps, "compose.yml"), "utf8");
  const install = readFileSync(path.join(vps, "install.sh"), "utf8");
  // The app service block, up to the next service at the same indent.
  const app = compose.match(
    /\n {2}app:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/,
  )?.[1];

  it("hands the app the token file and the repo pairs, never the token", () => {
    expect(app).toBeDefined();
    expect(app).toContain(
      "SSR_PUSH_GITHUB_TOKEN_FILE: /run/tb-secrets/ssr_push_github_token",
    );
    // Compose syntax, not a JS template: built so the literal stays literal.
    expect(app).toContain(`SSR_PUSH_REPOS: $\{SSR_PUSH_REPOS:-}`);
    expect(app).toContain("- ./secrets:/run/tb-secrets:ro");
    expect(app).not.toMatch(/SSR_PUSH_GITHUB_TOKEN:/);
  });

  it("install.sh locks the token file down and keeps SSR_PUSH_REPOS in .env", () => {
    expect(install).toMatch(
      /for optional in [^;\n]*\bssr_push_github_token\b[^;\n]*; do/,
    );
    expect(install).toContain("SSR_PUSH_REPOS=)");
    expect(install).toMatch(/for var in [^;\n]*\bSSR_PUSH_REPOS\b[^;\n]*; do/);
  });
});
