import { describe, expect, it } from "vite-plus/test";
import { removeSourceBody, SOURCE_URL_MAX } from "./schema";

describe("removeSourceBody (TB-132)", () => {
  it("takes one link or pull request a member added", () => {
    expect(
      removeSourceBody.safeParse({ kind: "link", ref: "https://example.com/a" })
        .success,
    ).toBe(true);
    expect(
      removeSourceBody.safeParse({ kind: "github-pr", ref: "owner/repo#7" })
        .success,
    ).toBe(true);
  });

  it("refuses the synced kinds, an empty ref and an overlong ref", () => {
    for (const kind of ["card", "doc", "upload", "rule"]) {
      expect(removeSourceBody.safeParse({ kind, ref: "x" }).success).toBe(
        false,
      );
    }
    expect(removeSourceBody.safeParse({ kind: "link", ref: "" }).success).toBe(
      false,
    );
    expect(
      removeSourceBody.safeParse({
        kind: "link",
        ref: `https://example.com/${"a".repeat(SOURCE_URL_MAX)}`,
      }).success,
    ).toBe(false);
  });
});
