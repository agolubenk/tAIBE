import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readPushTargets } from "./push-target";

const read = (value: string, extra: Record<string, string> = {}) =>
  readPushTargets({ SSR_PUSH_TARGETS: value, ...extra });

describe("SSR push targets (TB-160)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps each workspace to its own repo and branch", () => {
    expect([
      ...read(
        "ws-lav=agolubenk/HR_Helper-v2@main, ws-taibe = agolubenk/tAIBE@feature/ssr-push",
      ),
    ]).toEqual([
      ["ws-lav", { repo: "agolubenk/HR_Helper-v2", branch: "main" }],
      ["ws-taibe", { repo: "agolubenk/tAIBE", branch: "feature/ssr-push" }],
    ]);
  });

  it("has no default target: no variable, no workspace", () => {
    expect(readPushTargets({}).size).toBe(0);
    expect(read(" , ").size).toBe(0);
  });

  it("leaves out malformed entries and names them in one log line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const targets = read(
      [
        "ws-ok=a/b@main",
        "ws-no-branch=a/b",
        "ws-no-repo=@main",
        "ws-two-at=a/b@main@dev",
        "ws-two-eq=a/b@main=x",
        "=a/b@main",
        "ws-dotdot=a/..@main",
        "ws-dot=a/.@main",
        "ws-deep=a/b/c@main",
        "ws-branch-up=a/b@feature/../main",
        "ws-branch-dots=a/b@main..dev",
        "ws-branch-dot=a/b@feature/.hidden",
        "ws-branch-slash=a/b@/main",
        "ws-branch-query=a/b@main?x=1",
      ].join(","),
    );
    expect([...targets.keys()]).toEqual(["ws-ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    for (const id of ["ws-no-branch", "ws-dotdot", "(no workspace id)"]) {
      expect(line).toContain(id);
    }
  });

  it("leaves out a workspace named twice, even if one entry is valid", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const targets = read(
      "ws-a=a/b@main,ws-b=c/d@main,ws-a=e/f@main,ws-a=g/h@x",
    );
    expect([...targets.keys()]).toEqual(["ws-b"]);
  });

  it("says that the old single-repo variables are ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const targets = read("", {
      SSR_PUSH_GITHUB_REPO: "agolubenk/HR_Helper-v2",
      SSR_PUSH_GITHUB_BRANCH: "main",
    });
    expect(targets.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "SSR_PUSH_GITHUB_REPO, SSR_PUSH_GITHUB_BRANCH ignored",
      ),
    );
  });
});
