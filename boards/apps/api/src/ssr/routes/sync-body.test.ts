import { describe, expect, it } from "vite-plus/test";
import {
  SYNC_BODY_BYTES,
  SYNC_CONTENT_MAX,
  SYNC_MANIFEST_MAX,
  SYNC_PATH_MAX,
  syncBody,
} from "./schema";

const sha = "a".repeat(64);
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const entry = (index: number, content?: string) => ({
  path: `.claude/skills/s${index}/NOTE.md`,
  sha256: sha,
  ...(content === undefined ? {} : { content }),
});
const many = (count: number, content?: string) =>
  Array.from({ length: count }, (_, index) => entry(index, content));

// TB-129: a manifest without content goes to SYNC_MANIFEST_MAX entries; the
// files with content stay at SYNC_CONTENT_MAX.
describe("syncBody limits", () => {
  it("takes a manifest of up to 5000 files without content", () => {
    expect(
      syncBody.safeParse({ commitSha, files: many(SYNC_MANIFEST_MAX) }).success,
    ).toBe(true);
    expect(
      syncBody.safeParse({ commitSha, files: many(SYNC_MANIFEST_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it("keeps the files with content at 400 inside a bigger manifest", () => {
    const files = [
      ...many(SYNC_CONTENT_MAX, "x"),
      ...many(1000).map((file, index) => ({
        ...file,
        path: `.claude/rules/r${index}.md`,
      })),
    ];
    expect(syncBody.safeParse({ commitSha, files }).success).toBe(true);
    const over = syncBody.safeParse({
      commitSha,
      files: [...files, entry(9999, "x")],
    });
    expect(over.success).toBe(false);
    expect(JSON.stringify(over.error?.issues)).toContain(
      `at most ${SYNC_CONTENT_MAX} files with content`,
    );
  });

  it("takes up to 5000 deleted paths", () => {
    const deleted = (count: number) =>
      Array.from({ length: count }, (_, index) => `.claude/rules/d${index}.md`);
    expect(
      syncBody.safeParse({
        commitSha,
        files: [],
        deleted: deleted(SYNC_MANIFEST_MAX),
      }).success,
    ).toBe(true);
    expect(
      syncBody.safeParse({
        commitSha,
        files: [],
        deleted: deleted(SYNC_MANIFEST_MAX + 1),
      }).success,
    ).toBe(false);
  });

  // The coordinator's condition: the entry limit holds by bytes too. The
  // largest body the schema takes without content must leave the 12 MB bound
  // most of its room for content.
  it("fits the largest manifest without content well under the body bound", () => {
    const longPath = (index: number) =>
      `.claude/rules/${String(index).padStart(SYNC_PATH_MAX - 17, "x")}.md`;
    const body = {
      commitSha,
      files: Array.from({ length: SYNC_MANIFEST_MAX }, (_, index) => ({
        path: longPath(index),
        sha256: sha,
      })),
      deleted: Array.from({ length: SYNC_MANIFEST_MAX }, (_, index) =>
        longPath(index + SYNC_MANIFEST_MAX),
      ),
    };
    expect(body.files[0]?.path).toHaveLength(SYNC_PATH_MAX);
    expect(syncBody.safeParse(body).success).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    expect(bytes).toBeLessThan(SYNC_BODY_BYTES / 2);
  });
});
