import { describe, expect, it } from "vite-plus/test";
import { parsePullRequestRef } from "./github-pr-ref";

describe("parsePullRequestRef", () => {
  it.each([
    "https://github.com/Example/Repo.js/pull/12",
    "https://github.com/Example/Repo.js/pull/12/files?w=1#diff",
    "https://www.github.com/Example/Repo.js/pull/12",
    "  Example/Repo.js#12 ",
  ])("reads %s", (input) => {
    expect(parsePullRequestRef(input)).toEqual({
      owner: "Example",
      repo: "Repo.js",
      number: 12,
      ref: "example/repo.js#12",
    });
  });

  it.each([
    "http://github.com/example/repo/pull/12",
    "https://github.com/example/repo/issues/12",
    "https://github.example.com/example/repo/pull/12",
    "https://github.com/example/repo/pull/0",
    "https://github.com/-bad/repo/pull/1",
    "example/repo",
    "",
  ])("refuses %s with a 400", (input) => {
    expect(() => parsePullRequestRef(input)).toThrow(
      expect.objectContaining({ status: 400, code: "PR_INVALID_URL" }),
    );
  });
});
