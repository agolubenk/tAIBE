import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  ssrEntityTable,
  ssrVersionTable,
} from "../../apps/api/src/database/ssr-schema";
import {
  approveDraft,
  rollbackToVersion,
} from "../../apps/api/src/ssr/approve";
import { approveMatchingDrafts } from "../../apps/api/src/ssr/approve-matching";
import { resetTestDatabase } from "./helpers/database";
import { createForest } from "./helpers/forest";

// TB-258: one `latest` version per entity. A writer that waited for a lock
// behind another writer did not see the version that the other one made
// `latest` (READ COMMITTED: a statement does not see rows inserted after it
// began), and both versions stayed `latest`. Each test holds the other
// writer's locks by hand in a transaction, starts the real function, waits
// until it blocks on a row lock, and then commits.
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const PATH = ".claude/skills/kappa/NOTE.md";

// A transaction callback returns the pending writer inside an object: an
// async callback that returns the promise itself waits for it, and the writer
// waits for this transaction's locks.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function untilSomeoneWaitsOnALock() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the writer never waited on a row lock");
}

// An entity made by a real sync (so a later sync finds it by path), with
// versions set by hand: `statuses[i]` is the status of v(i + 1).
async function entityWith(
  statuses: Array<"latest" | "superseded" | "draft" | "rejected">,
) {
  const forest = await createForest();
  const ws = forest.workspace.id;
  const synced = await forest.ownerApi("POST", `/ssr/${ws}/sync`, {
    commitSha: "9091929394959697989990919293949596979899",
    files: [{ path: PATH, sha256: sha256("v1"), content: "v1" }],
  });
  expect(synced.status).toBe(200);
  const [first] = synced.body.created;
  if (!first) throw new Error("the sync made no draft");
  const [v1] = await db
    .select()
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.id, first.versionId));
  if (!v1) throw new Error("no v1");
  const ids = [v1.id];
  for (let number = 2; number <= statuses.length; number += 1) {
    const [row] = await db
      .insert(ssrVersionTable)
      .values({
        entityId: v1.entityId,
        number,
        blobSha: sha256(`v${number}`),
        files: v1.files,
        status: "draft",
        origin: "sync",
      })
      .returning({ id: ssrVersionTable.id });
    if (!row) throw new Error(`no v${number}`);
    ids.push(row.id);
  }
  for (const [at, status] of statuses.entries()) {
    await db
      .update(ssrVersionTable)
      .set({ status, approvedBy: status === "draft" ? null : forest.ownerId })
      .where(eq(ssrVersionTable.id, ids[at] as string));
  }
  const live = ids[statuses.indexOf("latest")] ?? null;
  await db
    .update(ssrEntityTable)
    .set({ latestVersionId: live, status: "active" })
    .where(eq(ssrEntityTable.id, v1.entityId));
  const id = (number: number) => ids[number - 1] as string;
  const state = async () => {
    const versions = await db
      .select({
        number: ssrVersionTable.number,
        status: ssrVersionTable.status,
      })
      .from(ssrVersionTable)
      .where(eq(ssrVersionTable.entityId, v1.entityId))
      .orderBy(asc(ssrVersionTable.number));
    const [entity] = await db
      .select({ latestVersionId: ssrEntityTable.latestVersionId })
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, v1.entityId));
    const latest = versions.filter((version) => version.status === "latest");
    return { latest, pointsAt: entity?.latestVersionId };
  };
  return {
    forest,
    ws,
    owner: forest.ownerId,
    entityId: v1.entityId,
    id,
    state,
  };
}

// The rollback holds the live version from its first write on.
async function lockRow(tx: Tx, versionId: string) {
  await tx
    .select({ id: ssrVersionTable.id })
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.id, versionId))
    .for("update");
}

// The rollback's writes as the base made them (approve.ts before TB-258):
// the live version read earlier → superseded, a new `latest`, the entity.
async function rollbackWrites(
  tx: Tx,
  entityId: string,
  liveId: string | null,
  number: number,
) {
  if (liveId) {
    await tx
      .update(ssrVersionTable)
      .set({ status: "superseded" })
      .where(eq(ssrVersionTable.id, liveId));
  }
  const [restored] = await tx
    .insert(ssrVersionTable)
    .values({
      entityId,
      number,
      blobSha: sha256("restored"),
      files: [],
      status: "latest",
      origin: "rollback",
    })
    .returning({ id: ssrVersionTable.id });
  if (!restored) throw new Error("no restored version");
  await tx
    .update(ssrEntityTable)
    .set({ latestVersionId: restored.id })
    .where(eq(ssrEntityTable.id, entityId));
  return restored.id;
}

// The approve's writes in its lock order: draft → live → entity.
async function approveWrites(tx: Tx, entityId: string, draftId: string) {
  await tx
    .update(ssrVersionTable)
    .set({ status: "latest" })
    .where(eq(ssrVersionTable.id, draftId));
  await tx
    .update(ssrVersionTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(ssrVersionTable.entityId, entityId),
        eq(ssrVersionTable.status, "latest"),
        sql`${ssrVersionTable.id} <> ${draftId}`,
      ),
    );
  await tx
    .update(ssrEntityTable)
    .set({ latestVersionId: draftId })
    .where(eq(ssrEntityTable.id, entityId));
}

describe("API integration: SSR keeps one latest version per entity (TB-258)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("an approve that waited behind a rollback supersedes the restored version", async () => {
    const { ws, owner, entityId, id, state } = await entityWith([
      "latest",
      "draft",
    ]);
    const { approve } = await db.transaction(async (tx) => {
      await lockRow(tx, id(1));
      const approve = approveDraft(
        ws,
        entityId,
        { versionId: id(2), blobSha: sha256("v2") },
        owner,
      );
      await untilSomeoneWaitsOnALock();
      await rollbackWrites(tx, entityId, id(1), 3);
      return { approve };
    });
    await approve;
    expect(await state()).toEqual({
      latest: [{ number: 2, status: "latest" }],
      pointsAt: id(2),
    });
  });

  it("a rollback that waited behind an approve supersedes the approved draft", async () => {
    const { ws, owner, entityId, id, state } = await entityWith([
      "latest",
      "draft",
    ]);
    const { rollback } = await db.transaction(async (tx) => {
      await approveWrites(tx, entityId, id(2));
      // The rollback read v1 as live and v2 as a draft: v2 may be restored.
      const rollback = rollbackToVersion(ws, entityId, 2, owner);
      await untilSomeoneWaitsOnALock();
      return { rollback };
    });
    const restored = await rollback;
    expect(await state()).toEqual({
      latest: [{ number: 3, status: "latest" }],
      pointsAt: restored.versionId,
    });
  });

  // The rollback's step before the entity row (supersedeLatest): without it
  // the rollback took the entity row, then waited for the live version that
  // the approve held, and the approve waited for the entity row (40P01).
  it("a rollback and an approve that holds the live version do not deadlock", async () => {
    const { ws, owner, entityId, id, state } = await entityWith([
      "latest",
      "draft",
    ]);
    const { rollback } = await db.transaction(async (tx) => {
      // The approve's steps before the entity row: the draft, the live version.
      await tx
        .update(ssrVersionTable)
        .set({ status: "latest" })
        .where(eq(ssrVersionTable.id, id(2)));
      await tx
        .update(ssrVersionTable)
        .set({ status: "superseded" })
        .where(eq(ssrVersionTable.id, id(1)));
      const rollback = rollbackToVersion(ws, entityId, 2, owner);
      await untilSomeoneWaitsOnALock();
      await tx
        .update(ssrEntityTable)
        .set({ latestVersionId: id(2) })
        .where(eq(ssrEntityTable.id, entityId));
      return { rollback };
    });
    const restored = await rollback;
    expect(await state()).toEqual({
      latest: [{ number: 3, status: "latest" }],
      pointsAt: restored.versionId,
    });
  });

  it("a batch approve that waited behind a rollback supersedes the restored version", async () => {
    const { forest, ws, owner, entityId, id, state } = await entityWith([
      "latest",
      "draft",
    ]);
    // The twin that vouches for v2: the same path and bytes, approved by the
    // owner in another workspace the owner reads.
    const [source] = await db
      .insert(schema.workspaceTable)
      .values({
        id: "ws-twin",
        name: "twin",
        slug: "ws-twin",
        createdAt: new Date(),
      })
      .returning();
    if (!source) throw new Error("no twin workspace");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: source.id,
      userId: forest.ownerId,
      role: "owner",
      joinedAt: new Date(),
    });
    const [here] = await db
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.id, entityId));
    if (!here) throw new Error("no entity");
    const [twin] = await db
      .insert(ssrEntityTable)
      .values({
        workspaceId: source.id,
        kind: here.kind,
        name: here.name,
        path: here.path,
        status: "active",
      })
      .returning({ id: ssrEntityTable.id });
    if (!twin) throw new Error("no twin entity");
    await db.insert(ssrVersionTable).values({
      entityId: twin.id,
      number: 1,
      blobSha: sha256("v2"),
      files: [],
      status: "latest",
      origin: "owner",
      approvedBy: owner,
      approvedAt: new Date(),
    });
    const readable = new Map([
      [ws, "here"],
      [source.id, "twin"],
    ]);

    const { batch } = await db.transaction(async (tx) => {
      await lockRow(tx, id(1));
      const batch = approveMatchingDrafts(
        ws,
        [{ versionId: id(2), blobSha: sha256("v2") }],
        readable,
        owner,
      );
      await untilSomeoneWaitsOnALock();
      await rollbackWrites(tx, entityId, id(1), 3);
      return { batch };
    });
    expect(await batch).toEqual({ approved: 1, versionIds: [id(2)] });
    expect(await state()).toEqual({
      latest: [{ number: 2, status: "latest" }],
      pointsAt: id(2),
    });
  });

  it("a sync that waited behind an approve supersedes the approved draft", async () => {
    // A rollback made v3 live above the open draft v2, so a sync bumps v3.
    const { forest, ws, entityId, id, state } = await entityWith([
      "superseded",
      "draft",
      "latest",
    ]);
    const { sync } = await db.transaction(async (tx) => {
      await approveWrites(tx, entityId, id(2));
      const sync = forest.ownerApi("POST", `/ssr/${ws}/sync`, {
        commitSha: "a0a1a2a3a4a5a6a7a8a9a0a1a2a3a4a5a6a7a8a9",
        files: [{ path: PATH, sha256: sha256("v4"), content: "v4" }],
      });
      await untilSomeoneWaitsOnALock();
      return { sync };
    });
    const synced = await sync;
    expect(synced.status).toBe(200);
    const [bump] = synced.body.bumped;
    expect(bump).toMatchObject({ number: 4 });
    expect(await state()).toEqual({
      latest: [{ number: 4, status: "latest" }],
      pointsAt: bump?.versionId,
    });
  });
  // No live version: the writer has nothing to wait for before the entity
  // row and waits on the entity row itself. The step after the entity
  // (keepOneLatest) must come after that lock: before it, it saw nothing.
  it("an approve with no live version that waited for the entity row supersedes the restored version", async () => {
    const { ws, owner, entityId, id, state } = await entityWith([
      "rejected",
      "draft",
    ]);
    const { approve } = await db.transaction(async (tx) => {
      await rollbackWrites(tx, entityId, null, 3);
      const approve = approveDraft(
        ws,
        entityId,
        { versionId: id(2), blobSha: sha256("v2") },
        owner,
      );
      await untilSomeoneWaitsOnALock();
      return { approve };
    });
    await approve;
    expect(await state()).toEqual({
      latest: [{ number: 2, status: "latest" }],
      pointsAt: id(2),
    });
  });

  it("a rollback with no live version that waited for the entity row supersedes the approved draft", async () => {
    const { ws, owner, entityId, id, state } = await entityWith([
      "rejected",
      "draft",
    ]);
    const { rollback } = await db.transaction(async (tx) => {
      await approveWrites(tx, entityId, id(2));
      const rollback = rollbackToVersion(ws, entityId, 1, owner);
      await untilSomeoneWaitsOnALock();
      return { rollback };
    });
    const restored = await rollback;
    expect(await state()).toEqual({
      latest: [{ number: 3, status: "latest" }],
      pointsAt: restored.versionId,
    });
  });
});
