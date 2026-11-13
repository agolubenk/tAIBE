import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrPushStateTable,
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
      draft.versionId,
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
      draft.versionId,
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
        draft.versionId,
        forest.ownerId,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  // TB-129: the sync is the whole manifest (RU-13), so the corpus limit is
  // the manifest limit. Up to 5000 files go by sha; new bytes stay at 400.
  it("syncs a corpus of more than 400 files and still archives what the manifest leaves out", async () => {
    const forest = await createForest();
    const commitSha = "3031323334353637383930313233343536373839";
    const file = (skill: number, index: number, text = "") => {
      const content = `skill ${skill} file ${index}${text}`;
      return {
        path: `.claude/skills/s${skill}/f${index}.md`,
        sha256: sha256(content),
        content,
      };
    };
    const skill = (n: number) =>
      Array.from({ length: 50 }, (_, index) => file(n, index));
    const skills = (...ns: number[]) => ns.flatMap(skill);
    const bySha = (files: Array<{ path: string; sha256: string }>) =>
      files.map(({ path, sha256: sha }) => ({ path, sha256: sha }));
    const sync = (files: unknown[]) =>
      forest.ownerApi("POST", `/ssr/${forest.workspace.id}/sync`, {
        commitSha,
        files,
      });

    // Archiving and auto-bump concern live entities: the owner approves the
    // drafts a sync created.
    const approveAll = async () => {
      const drafts = await db
        .select({
          entityId: ssrVersionTable.entityId,
          versionId: ssrVersionTable.id,
        })
        .from(ssrVersionTable)
        .innerJoin(
          ssrEntityTable,
          eq(ssrEntityTable.id, ssrVersionTable.entityId),
        )
        .where(
          and(
            eq(ssrEntityTable.workspaceId, forest.workspace.id),
            eq(ssrVersionTable.status, "draft"),
          ),
        );
      for (const draft of drafts) {
        await approveDraft(
          forest.workspace.id,
          draft.entityId,
          draft.versionId,
          forest.ownerId,
        );
      }
    };

    expect((await sync(skills(0, 1, 2, 3, 4, 5))).status).toBe(200);
    await approveAll();

    // 450 files: 300 by sha, 150 new with content.
    const second = await sync([
      ...bySha(skills(0, 1, 2, 3, 4, 5)),
      ...skills(6, 7, 8),
    ]);
    expect(second.status).toBe(200);
    expect(second.body.created).toHaveLength(3);
    expect(second.body.unchanged).toBe(6);
    await approveAll();

    // Boards lens on #230: the sync agent asks /known-shas about the whole
    // manifest before /sync. 5000 shas pass; the 450 stored ones come back.
    const stored = skills(0, 1, 2, 3, 4, 5, 6, 7, 8).map((f) => f.sha256);
    const unknown = Array.from({ length: 5000 - stored.length }, (_, index) =>
      sha256(`not stored ${index}`),
    );
    const known = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/known-shas`,
      { shas: [...stored, ...unknown] },
    );
    expect(known.status).toBe(200);
    expect([...known.body.shas].sort()).toEqual([...stored].sort());
    const over = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/known-shas`,
      { shas: [...stored, ...unknown, sha256("one more")] },
    );
    expect(over.status).toBe(400);

    // 450 files again: s8 is left out and archived, s9 is new, one file of
    // s0 changes.
    const changed = file(0, 0, " v2");
    const third = await sync([
      changed,
      ...bySha(skills(0, 1, 2, 3, 4, 5, 6, 7)).slice(1),
      ...skill(9),
    ]);
    expect(third.status).toBe(200);
    expect(third.body.archived).toEqual([".claude/skills/s8"]);
    expect(third.body.created).toHaveLength(1);
    expect(third.body.bumped).toHaveLength(1);

    // The push baseline has one row a path, the last sha of each.
    const baseline = await db
      .select()
      .from(ssrPushStateTable)
      .where(eq(ssrPushStateTable.workspaceId, forest.workspace.id));
    expect(baseline).toHaveLength(500);
    expect(
      baseline.find((row) => row.path === changed.path)?.lastSyncedSha,
    ).toBe(changed.sha256);

    // 401 files with content: the whole sync is refused, nothing archived.
    const tooMuch = await sync([
      ...bySha(skills(0, 1, 2, 3, 4, 5, 6, 7, 9)),
      ...Array.from({ length: 401 }, (_, index) => file(20 + index, 0)),
    ]);
    expect(tooMuch.status).toBe(400);
    const active = await db
      .select({ path: ssrEntityTable.path })
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.status, "active"));
    expect(active.length).toBeGreaterThanOrEqual(6);
    expect(active.map((row) => row.path)).not.toContain(".claude/skills/s20");
  });

  it("names a path twice in one sync: the baseline keeps the last sha", async () => {
    const forest = await createForest();
    const one = { path: ".claude/rules/twice.md", content: "one" };
    const two = { path: ".claude/rules/twice.md", content: "two" };
    const res = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/sync`,
      {
        commitSha: "3031323334353637383930313233343536373839",
        files: [one, two].map((file) => ({
          ...file,
          sha256: sha256(file.content),
        })),
      },
    );
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(ssrPushStateTable)
      .where(eq(ssrPushStateTable.path, one.path));
    expect(row?.lastSyncedSha).toBe(sha256("two"));
  });

  // The entry limit holds by bytes too: the largest manifest the schema
  // takes, with 500-character paths, passes the 12 MB body bound and reaches
  // the sync (409 for shas the workspace does not hold), not a 413.
  it("takes the largest manifest under the body bound", async () => {
    const forest = await createForest();
    const longPath = (index: number) =>
      `.claude/rules/${String(index).padStart(483, "x")}.md`;
    const res = await forest.ownerApi(
      "POST",
      `/ssr/${forest.workspace.id}/sync`,
      {
        commitSha: "3031323334353637383930313233343536373839",
        files: Array.from({ length: 5000 }, (_, index) => ({
          path: longPath(index),
          sha256: sha256(String(index)),
        })),
        deleted: Array.from({ length: 5000 }, (_, index) =>
          longPath(index + 5000),
        ),
      },
    );
    expect(longPath(0)).toHaveLength(500);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Content required");
  });
});
