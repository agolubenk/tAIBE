import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
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

// TB-89: the batch approve (approve-matching.ts) locks the draft rows first
// and the live version after them. The single approve took the live version
// first, so a single and a batch decision on one entity at the same moment
// deadlocked (Postgres 40P01). Both paths now take draft → live → entity.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

async function untilSomeoneWaitsOnALock() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the single approve never waited on a row lock");
}

describe("API integration: SSR single and batch approve share one lock order", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  // An entity with a live v1 and an open draft v2 on top of it.
  async function liveAndDraft() {
    const forest = await createForest();
    const ws = forest.workspace.id;
    const text = "live bytes";
    const synced = await forest.ownerApi("POST", `/ssr/${ws}/sync`, {
      commitSha: "8081828384858687888980818283848586878889",
      files: [
        {
          path: ".claude/skills/kappa/NOTE.md",
          sha256: sha256(text),
          content: text,
        },
      ],
    });
    expect(synced.status).toBe(200);
    const [first] = synced.body.created;
    if (!first) throw new Error("the sync made no draft");
    const [live] = await db
      .select()
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.id, first.versionId));
    if (!live) throw new Error("no draft row");
    await approveDraft(
      ws,
      live.entityId,
      { versionId: live.id, blobSha: live.blobSha },
      forest.ownerId,
    );
    // Sync auto-bumps a live entity, so the second draft is written directly.
    const draftSha = sha256("draft bytes");
    const [draft] = await db
      .insert(ssrVersionTable)
      .values({
        entityId: live.entityId,
        number: 2,
        blobSha: draftSha,
        files: live.files,
        status: "draft",
        origin: "sync",
      })
      .returning({ id: ssrVersionTable.id });
    if (!draft) throw new Error("no second draft");
    const versions = () =>
      db
        .select({
          number: ssrVersionTable.number,
          status: ssrVersionTable.status,
        })
        .from(ssrVersionTable)
        .where(eq(ssrVersionTable.entityId, live.entityId))
        .orderBy(asc(ssrVersionTable.number));
    return {
      ws,
      owner: forest.ownerId,
      entityId: live.entityId,
      seen: { versionId: draft.id, blobSha: draftSha },
      versions,
    };
  }

  it("a single approve waits behind a batch that holds the draft, then finds it decided", async () => {
    const { ws, owner, entityId, seen, versions } = await liveAndDraft();

    // The batch's writes in the batch's order, with a pause after the first
    // lock so that the single approve starts in between.
    const { single } = await db.transaction(async (tx) => {
      const locked = await lockOpenDrafts(tx, ws, [seen.versionId]);
      expect(locked).toHaveLength(1);
      const single = approveDraft(ws, entityId, seen, owner).then(
        () => "approved",
        (error: {
          status?: number;
          code?: string;
          cause?: { code?: string };
        }) => error.cause?.code ?? error.code ?? `status ${error.status}`,
      );
      await untilSomeoneWaitsOnALock();
      await tx
        .update(ssrVersionTable)
        .set({ status: "superseded" })
        .where(
          and(
            eq(ssrVersionTable.entityId, entityId),
            eq(ssrVersionTable.status, "latest"),
          ),
        );
      await tx
        .update(ssrVersionTable)
        .set({ status: "latest", approvedBy: owner, approvedAt: new Date() })
        .where(eq(ssrVersionTable.id, seen.versionId));
      await tx
        .update(ssrEntityTable)
        .set({ latestVersionId: seen.versionId })
        .where(eq(ssrEntityTable.id, entityId));
      return { single };
    });

    // No 40P01 on either side: the batch committed, the single one got the
    // plain "not an open draft" conflict.
    expect(await single).toBe("status 409");
    expect(await versions()).toEqual([
      { number: 1, status: "superseded" },
      { number: 2, status: "latest" },
    ]);
  });

  it("two single approves of one draft at once: one wins, the other is a conflict", async () => {
    const { ws, owner, entityId, seen, versions } = await liveAndDraft();

    const outcomes = await Promise.allSettled([
      approveDraft(ws, entityId, seen, owner),
      approveDraft(ws, entityId, seen, owner),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [refused] = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toMatchObject({ reason: { status: 409 } });
    expect(await versions()).toEqual([
      { number: 1, status: "superseded" },
      { number: 2, status: "latest" },
    ]);
  });
});
