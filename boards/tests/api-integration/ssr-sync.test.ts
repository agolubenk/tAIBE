import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { approveDraft, rejectDraft } from "../../apps/api/src/ssr/approve";
import { replaceOpenDraft } from "../../apps/api/src/ssr/replace-open-draft";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// syncCorpus stores one ssr_blob row per unseen sha; two empty corpus files
// share the empty-string sha and used to violate ssr_blob_pkey inside a
// single multi-row insert (the stand hit it on its first real sync).
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const blobShaOf = async (versionId: string) => {
  const [row] = await db
    .select({ blobSha: ssrVersionTable.blobSha })
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.id, versionId));
  if (!row) throw new Error(`no version ${versionId}`);
  return row.blobSha;
};

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
    // stacking version numbers (ssr_version_entity_number_key). New bytes
    // come with their content; a sha the workspace holds goes without.
    const changed = [
      {
        path: ".claude/skills/alpha/NOTE.md",
        sha256: sha256("new text"),
        content: "new text",
      },
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

  it("a rejected draft with new content waits as draft 2, never goes live, and does not break the sync", async () => {
    const forest = await createForest();
    const path = ".claude/skills/gamma/NOTE.md";
    const commitSha = "4041424344454647484940414243444546474849";
    const sync = (text: string) =>
      forest.ownerApi("POST", `/ssr/${forest.workspace.id}/sync`, {
        commitSha,
        files: [{ path, sha256: sha256(text), content: text }],
      });

    const first = await sync("v1");
    expect(first.status).toBe(200);
    const [draft] = first.body.created;
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.workspaceId, forest.workspace.id));
    if (!entity || !draft) throw new Error("the first sync made no draft");
    await rejectDraft(
      forest.workspace.id,
      entity.id,
      {
        versionId: draft.versionId,
        blobSha: await blobShaOf(draft.versionId),
      },
      forest.ownerId,
    );

    // Numbering from "latest" reused 1 here (ssr_version_entity_number_key),
    // and the rejected entity would have gone live without the owner (Q-015).
    const changed = await sync("v2");
    expect(changed.status).toBe(200);
    expect(changed.body.created).toEqual([
      expect.objectContaining({ number: 2, status: "draft" }),
    ]);
    expect(changed.body.bumped).toHaveLength(0);

    const again = await sync("v2");
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(1);

    const versions = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.entityId, entity.id))
      .orderBy(ssrVersionTable.number);
    expect(versions.map((v) => [v.number, v.status])).toEqual([
      [1, "rejected"],
      [2, "draft"],
    ]);
    const [after] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, entity.id));
    expect(after?.latestVersionId).toBeNull();
  });

  it("an in-place draft update with a stale id never rewrites a version the owner approved", async () => {
    const forest = await createForest();
    const path = ".claude/skills/delta/NOTE.md";
    const commitSha = "5051525354555657585950515253545556575859";
    const sync = (text: string) =>
      forest.ownerApi("POST", `/ssr/${forest.workspace.id}/sync`, {
        commitSha,
        files: [{ path, sha256: sha256(text), content: text }],
      });
    const first = await sync("approved bytes");
    const [draft] = first.body.created;
    const [entity] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.workspaceId, forest.workspace.id));
    if (!entity || !draft) throw new Error("the first sync made no draft");
    const [read] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, draft.versionId));
    if (!read) throw new Error("no draft row");

    // The sync read the draft, then the owner approved it.
    await approveDraft(
      forest.workspace.id,
      entity.id,
      { versionId: draft.versionId, blobSha: read.blobSha },
      forest.ownerId,
    );
    const replaced = await replaceOpenDraft(db, draft.versionId, {
      blobSha: sha256("newer corpus"),
      files: [],
      commitSha,
      createdBy: forest.ownerId,
    });
    expect(replaced).toBe(false);
    const [kept] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, draft.versionId));
    expect(kept?.status).toBe("latest");
    expect(kept?.blobSha).toBe(read.blobSha);
    expect(kept?.files).toEqual(read.files);

    // The newer corpus then lands as a new version on top of the decision.
    const changed = await sync("newer corpus");
    expect(changed.status).toBe(200);
    expect(changed.body.bumped).toEqual([
      expect.objectContaining({ number: 2 }),
    ]);
    const versions = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.entityId, entity.id))
      .orderBy(ssrVersionTable.number);
    expect(versions.map((v) => [v.number, v.status, v.blobSha])).toEqual([
      [1, "superseded", read.blobSha],
      [2, "latest", expect.not.stringMatching(read.blobSha)],
    ]);

    // Rejecting what is no longer a draft is refused, not overwritten.
    await expect(
      rejectDraft(
        forest.workspace.id,
        entity.id,
        { versionId: draft.versionId, blobSha: read.blobSha },
        forest.ownerId,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
