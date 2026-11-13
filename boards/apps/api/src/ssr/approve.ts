import { and, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";
import { ApiError } from "../errors/api-error";

// Owner decisions (spec RU-7, Q-015, D-005): approving a draft makes it the
// served latest; rollback re-publishes an old snapshot as a new version and
// fires the immediate push-back (N-3), so the repo never lags a day behind
// what agents already serve.

// The draft the owner decides on: its id and the aggregate blob sha of the
// bytes the open diff showed (TB-88). The sync rewrites a draft in place under
// the same id, so the id alone could approve or reject bytes nobody saw.
export type SeenDraft = { versionId: string; blobSha: string };

export async function approveDraft(
  workspaceId: string,
  entityId: string,
  seen: SeenDraft,
  owner: string,
) {
  const entity = await assertEntity(workspaceId, entityId);
  return db.transaction(async (tx) => {
    await tx
      .update(ssrVersionTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(ssrVersionTable.entityId, entityId),
          eq(ssrVersionTable.status, "latest"),
        ),
      );
    // Status and bytes are checked in the UPDATE itself: Postgres re-reads
    // the row after the lock, so a sync or decision that committed first
    // makes this touch nothing instead of approving other bytes.
    const [approved] = await tx
      .update(ssrVersionTable)
      .set({ status: "latest", approvedBy: owner, approvedAt: new Date() })
      .where(seenDraftRow(entityId, seen))
      .returning({ number: ssrVersionTable.number });
    if (!approved) throw await decisionConflict(tx, entityId, seen);
    await tx
      .update(ssrEntityTable)
      .set({
        latestVersionId: seen.versionId,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(ssrEntityTable.id, entity.id));
    return { entityId, versionId: seen.versionId, number: approved.number };
  });
}

export async function rejectDraft(
  workspaceId: string,
  entityId: string,
  seen: SeenDraft,
  owner: string,
) {
  await assertEntity(workspaceId, entityId);
  // Same check in the UPDATE as for approval: no lost update, no other bytes.
  const [rejected] = await db
    .update(ssrVersionTable)
    .set({ status: "rejected", approvedBy: owner, approvedAt: new Date() })
    .where(seenDraftRow(entityId, seen))
    .returning({ id: ssrVersionTable.id });
  if (!rejected) throw await decisionConflict(db, entityId, seen);
  return { entityId, versionId: seen.versionId };
}

export async function rollbackToVersion(
  workspaceId: string,
  entityId: string,
  toNumber: number,
  owner: string,
) {
  const entity = await assertEntity(workspaceId, entityId);
  const versions = await db
    .select()
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.entityId, entityId))
    .orderBy(desc(ssrVersionTable.number));
  const source = versions.find((version) => version.number === toNumber);
  const latest = versions.find((version) => version.status === "latest");
  if (!source) {
    throw new HTTPException(404, { message: `Version ${toNumber} not found` });
  }
  if (latest && source.id === latest.id) {
    throw new HTTPException(409, { message: "That version is already latest" });
  }
  const number = (versions[0]?.number ?? 0) + 1;
  const restored = await db.transaction(async (tx) => {
    if (latest) {
      await tx
        .update(ssrVersionTable)
        .set({ status: "superseded" })
        .where(eq(ssrVersionTable.id, latest.id));
    }
    const inserted = await tx
      .insert(ssrVersionTable)
      .values({
        entityId,
        number,
        blobSha: source.blobSha,
        files: source.files,
        status: "latest",
        origin: "rollback",
        message: `Restored from v${toNumber}`,
        createdBy: owner,
        approvedBy: owner,
        approvedAt: new Date(),
      })
      .returning({ id: ssrVersionTable.id });
    const version = inserted[0];
    if (!version) throw new Error("rollback insert returned nothing");
    await tx
      .update(ssrEntityTable)
      .set({ latestVersionId: version.id, updatedAt: new Date() })
      .where(eq(ssrEntityTable.id, entity.id));
    return version;
  });
  return { entityId, versionId: restored.id, number, restoredFrom: toNumber };
}

const notOpenDraft = () =>
  new HTTPException(409, { message: "Version is not an open draft" });

const seenDraftRow = (entityId: string, seen: SeenDraft) =>
  and(
    eq(ssrVersionTable.id, seen.versionId),
    eq(ssrVersionTable.entityId, entityId),
    eq(ssrVersionTable.status, "draft"),
    eq(ssrVersionTable.blobSha, seen.blobSha),
  );

// Why the guarded UPDATE touched nothing. Read only after the miss, so the
// happy path stays one statement. A still-open draft with other bytes means
// the sync replaced it after the diff: the owner must look again.
async function decisionConflict(
  executor: Pick<typeof db, "select">,
  entityId: string,
  seen: SeenDraft,
) {
  const [current] = await executor
    .select({
      status: ssrVersionTable.status,
      blobSha: ssrVersionTable.blobSha,
    })
    .from(ssrVersionTable)
    .where(
      and(
        eq(ssrVersionTable.id, seen.versionId),
        eq(ssrVersionTable.entityId, entityId),
      ),
    );
  // The guarded UPDATE missed an open draft: its bytes moved after the diff,
  // even if a later sync brought the same sha back (A→B→A). Either way the
  // owner reviews the diff again.
  if (current?.status === "draft") {
    return new ApiError(409, {
      code: "SSR_DRAFT_CHANGED",
      message:
        "The draft changed after you opened the diff; review it again before deciding",
    });
  }
  return notOpenDraft();
}

async function assertEntity(workspaceId: string, entityId: string) {
  const [entity] = await db
    .select()
    .from(ssrEntityTable)
    .where(
      and(
        eq(ssrEntityTable.id, entityId),
        eq(ssrEntityTable.workspaceId, workspaceId),
      ),
    );
  if (!entity) throw new HTTPException(404, { message: "Entity not found" });
  return entity;
}
