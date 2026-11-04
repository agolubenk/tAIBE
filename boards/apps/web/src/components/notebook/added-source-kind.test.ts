import { describe, expect, it } from "vite-plus/test";
import { addedSourceKind, isRefreshable } from "./added-source-kind";
import { sourceErrorCode } from "./source-error-code";

describe("addedSourceKind", () => {
  it.each([
    ["https://github.com/example/repo/pull/7", "github-pr"],
    ["https://www.github.com/example/repo.js/pull/7/files#diff", "github-pr"],
    ["example/repo#7", "github-pr"],
    ["https://github.com/example/repo/issues/7", "link"],
    ["https://github.com/example/repo", "link"],
    ["https://docs.example.com/pull/7", "link"],
  ])("%s → %s", (input, kind) => {
    expect(addedSourceKind(input)).toBe(kind);
  });

  it("offers a refresh only on the kinds added here", () => {
    expect(
      ["link", "github-pr", "card", "repo-doc"].map(isRefreshable),
    ).toEqual([true, true, false, false]);
  });

  it("knows the API's refusal codes and nothing else", () => {
    expect(sourceErrorCode({ code: "LINK_PRIVATE_DESTINATION" })).toBe(
      "LINK_PRIVATE_DESTINATION",
    );
    expect(sourceErrorCode({ code: "FORBIDDEN" })).toBeNull();
    expect(sourceErrorCode(new Error("x"))).toBeNull();
  });
});
