import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// syncCorpus stores one ssr_blob row per unseen sha; two empty corpus files
// share the empty-string sha and used to violate ssr_blob_pkey inside a
// single multi-row insert (the stand hit it on its first real sync).
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("API integration: SSR corpus sync", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("takes two empty files in one sync: the shared empty sha is stored once", async () => {
    const forest = await createForest();
    const empty = sha256("");
    const files = [
      { path: ".claude/skills/alpha/NOTE.md", sha256: empty, content: "" },
      { path: ".claude/skills/beta/NOTE.md", sha256: empty, content: "" },
    ];
    const commitSha = "3031323334353637383930313233343536373839";

    const first = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/sync`,
      { commitSha, files },
    );
    expect(first.status).toBe(200);
    expect(first.body.created).toHaveLength(2);

    const second = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/sync`,
      { commitSha, files },
    );
    expect(second.status).toBe(200);
    expect(second.body.unchanged).toBe(2);

    // A changed file replaces the waiting draft in place instead of
    // stacking version numbers (ssr_version_entity_number_key).
    const changed = [
      { path: ".claude/skills/alpha/NOTE.md", sha256: sha256("new text") },
      { path: ".claude/skills/beta/NOTE.md", sha256: empty },
    ];
    const third = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/sync`,
      { commitSha, files: changed },
    );
    expect(third.status).toBe(200);
    expect(third.body.created).toHaveLength(1);
    expect(third.body.unchanged).toBe(1);
  });
});
