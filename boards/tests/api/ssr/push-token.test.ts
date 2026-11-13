import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { pushToken } from "../../../apps/api/src/ssr/push-token";

// TB-116: on the VPS the push-back token comes as a secret file, not as env.
describe("pushToken", () => {
  const dirs: string[] = [];
  const secretFile = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "tb116-"));
    dirs.push(dir);
    const path = join(dir, "ssr_push_github_token");
    writeFileSync(path, content);
    return path;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads the token file on every call, so a rotation needs no restart", () => {
    const path = secretFile("tok-1\n");
    const env = { SSR_PUSH_GITHUB_TOKEN_FILE: path };
    expect(pushToken(env)).toBe("tok-1");
    writeFileSync(path, "tok-2");
    expect(pushToken(env)).toBe("tok-2");
  });

  it("prefers the dev variable to the file", () => {
    const path = secretFile("from-file");
    expect(
      pushToken({
        SSR_PUSH_GITHUB_TOKEN: " from-env ",
        SSR_PUSH_GITHUB_TOKEN_FILE: path,
      }),
    ).toBe("from-env");
  });

  it("is off with no variable, an empty file or a missing file, and is silent on a missing one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pushToken({})).toBeUndefined();
    expect(
      pushToken({
        SSR_PUSH_GITHUB_TOKEN: "  ",
        SSR_PUSH_GITHUB_TOKEN_FILE: " ",
      }),
    ).toBeUndefined();
    expect(
      pushToken({ SSR_PUSH_GITHUB_TOKEN_FILE: secretFile(" \n") }),
    ).toBeUndefined();
    expect(
      pushToken({
        SSR_PUSH_GITHUB_TOKEN_FILE: join(tmpdir(), "tb116-none", "x"),
      }),
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on an unreadable path without the content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = secretFile("x").replace(/\/ssr_push_github_token$/, "");
    expect(pushToken({ SSR_PUSH_GITHUB_TOKEN_FILE: dir })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/not readable \(EISDIR\)/);
  });
});
