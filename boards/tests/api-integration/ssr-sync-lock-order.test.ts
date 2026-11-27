import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import { approveDraft } from "../../apps/api/src/ssr/approve";
import { lockOpenDrafts } from "../../apps/api/src/ssr/draft-matches";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";
import { untilSomeoneWaitsOnALock } from "./helpers/lock-wait";

// TB-149: the batch approve locks its drafts in id order (TB-89). A sync
// replaced open drafts one at a time in the order of the paths it got, so a
// sync and a batch that shared two drafts could lock them in opposite orders,
// and Postgres ended one of them with 40P01. The sync now locks the open
// drafts of the workspace first, in id order.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const COMMIT = "9091929394959697989990919293949596979899";
const file = (name: string, text: string) => ({
  path: `.claude/skills/${name}/NOTE.md`,
  sha256: sha256(text),
  content: text,
});

describe("API integration: SSR sync locks drafts in the batch order (TB-149)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  // Two entities, each with a live v1 and an open draft v2, in id order.
  async function twoDraftsInIdOrder() {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const synced = await forest.ownerApi("POST", `/ssr/${ws}/sync`, {
      commitSha: COMMIT,
      files: [file("alpha", "alpha v1"), file("beta", "beta v1")],
    });
    expect(synced.status).toBe(200);
    const drafts: { id: string; entityId: string; name: string }[] = [];
    for (const created of synced.body.created as {
      versionId: string;
      entity: string;
    }[]) {
      const [live] = await db
        .select()
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.id, created.versionId));
      if (!live) throw new Error("no draft row");
      await approveDraft(
        ws,
        live.entityId,
        { versionId: live.id, blobSha: live.blobSha },
        forest.ownerId,
      );
      // Sync auto-bumps a live entity, so the second draft is written directly.
      const [draft] = await db
        .insert(ssrVersionTable)
        .values({
          entityId: live.entityId,
          number: 2,
          blobSha: sha256(`${created.entity} draft`),
          files: live.files,
          status: "draft",
          origin: "sync",
        })
        .returning({ id: ssrVersionTable.id });
      if (!draft) throw new Error("no second draft");
      drafts.push({
        id: draft.id,
        entityId: live.entityId,
        name: created.entity,
      });
    }
    // The order Postgres locks them in, not the order of the JS strings.
    const ordered = await db
      .select({ id: ssrVersionTable.id })
      .from(ssrVersionTable)
      .where(
        inArray(
          ssrVersionTable.id,
          drafts.map((draft) => draft.id),
        ),
      )
      .orderBy(asc(ssrVersionTable.id));
    const [low, high] = ordered.map(
      (row) =>
        drafts.find((draft) => draft.id === row.id) as (typeof drafts)[0],
    );
    if (!low || !high) throw new Error("two drafts expected");
    return { forest, ws, low, high };
  }

  it("a sync that names the drafts against the id order waits behind a batch, without 40P01", async () => {
    const { forest, ws, low, high } = await twoDraftsInIdOrder();

    // The batch's locks in the batch's order, with a pause after the first
    // one, so that the sync starts in between. The sync names the higher
    // draft first.
    const { sync } = await db.transaction(async (tx) => {
      expect(await lockOpenDrafts(tx, ws, [low.id])).toHaveLength(1);
      const sync = forest.ownerApi("POST", `/ssr/${ws}/sync`, {
        commitSha: COMMIT,
        files: [
          file(high.name, `${high.name} v3`),
          file(low.name, `${low.name} v3`),
        ],
      });
      await untilSomeoneWaitsOnALock("the sync");
      // Before TB-149 the sync held the higher draft here: a deadlock.
      expect(await lockOpenDrafts(tx, ws, [high.id])).toHaveLength(1);
      for (const draft of [low, high]) {
        await tx
          .update(ssrVersionTable)
          .set({ status: "superseded" })
          .where(
            and(
              eq(ssrVersionTable.entityId, draft.entityId),
              eq(ssrVersionTable.status, "latest"),
            ),
          );
        await tx
          .update(ssrVersionTable)
          .set({ status: "latest", approvedAt: new Date() })
          .where(eq(ssrVersionTable.id, draft.id));
        await tx
          .update(ssrEntityTable)
          .set({ latestVersionId: draft.id })
          .where(eq(ssrEntityTable.id, draft.entityId));
      }
      return { sync };
    });

    // The batch committed; the sync then found both drafts decided and put
    // its corpus on top of them as a new live version.
    const synced = await sync;
    expect(synced.status).toBe(200);
    expect(synced.body.bumped).toHaveLength(2);
    for (const draft of [low, high]) {
      const versions = await db
        .select({
          number: ssrVersionTable.number,
          status: ssrVersionTable.status,
        })
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.entityId, draft.entityId))
        .orderBy(asc(ssrVersionTable.number));
      expect(versions).toEqual([
        { number: 1, status: "superseded" },
        { number: 2, status: "superseded" },
        { number: 3, status: "latest" },
      ]);
    }
  });

  it("a sync still replaces an open draft in place", async () => {
    const { forest, ws, low } = await twoDraftsInIdOrder();
    const synced = await forest.ownerApi("POST", `/ssr/${ws}/sync`, {
      commitSha: COMMIT,
      files: [file("alpha", "alpha v2b"), file("beta", "beta v2b")],
    });
    expect(synced.status).toBe(200);
    expect(synced.body.bumped).toHaveLength(0);
    const [draft] = await db
      .select({ status: ssrVersionTable.status })
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, low.id));
    expect(draft?.status).toBe("draft");
    expect(
      (synced.body.created as { versionId: string }[])
        .map((created) => created.versionId)
        .includes(low.id),
    ).toBe(true);
  });
});
