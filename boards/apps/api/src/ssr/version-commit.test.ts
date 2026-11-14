import { describe, expect, it } from "vite-plus/test";
import { versionCommit } from "./version-commit";

const HOST = "a".repeat(40);
const HOME = "b".repeat(40);

describe("versionCommit (TB-98)", () => {
  it("signs host files with the sync's commit", () => {
    expect(versionCommit([{}, {}], HOST)).toBe(HOST);
    expect(versionCommit([], HOST)).toBe(HOST);
  });

  it("signs files of the product home with the home's commit", () => {
    expect(
      versionCommit([{ commitSha: HOME }, { commitSha: HOME }], HOST),
    ).toBe(HOME);
  });

  it("falls back to the sync's commit when one entity mixes checkouts", () => {
    expect(versionCommit([{ commitSha: HOME }, {}], HOST)).toBe(HOST);
    expect(
      versionCommit([{ commitSha: HOME }, { commitSha: "c".repeat(40) }], HOST),
    ).toBe(HOST);
  });
});
