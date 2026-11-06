import { and, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";

// Owner decisions (spec RU-7, Q-015, D-005): approving a draft makes it the
// served latest; rollback re-publishes an old snapshot as a new version and
// fires the immediate push-back (N-3), so the repo never lags a day behind
// what agents already serve.

export async function approveDraft(
  workspaceId: string,
  entityId: string,
  versionId: string,
  owner: string,
) {
  const entity = await assertEntity(workspaceId, entityId);
  const [draft] = await db
    .select()
    .from(ssrVersionTable)
    .where(
      and(
        eq(ssrVersionTable.id, versionId),
        eq(ssrVersionTable.entityId, entityId),
      ),
    );
  if (!draft || draft.status !== "draft") {
    throw new HTTPException(409, { message: "Version is not an open draft" });
  }
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
    const approved = await tx
      .update(ssrVersionTable)
      .set({ status: "latest", approvedBy: owner, approvedAt: new Date() })
      .where(
        and(
          eq(ssrVersionTable.id, versionId),
          eq(ssrVersionTable.status, "draft"),
        ),
      )
      .returning({ id: ssrVersionTable.id });
    if (approved.length === 0) throw notOpenDraft();
    await tx
      .update(ssrEntityTable)
      .set({
        latestVersionId: versionId,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(ssrEntityTable.id, entity.id));
    return { entityId, versionId, number: draft.number };
  });
}

export async function rejectDraft(
  workspaceId: string,
  entityId: string,
  versionId: string,
  owner: string,
) {
  await assertEntity(workspaceId, entityId);
  const [draft] = await db
    .select()
    .from(ssrVersionTable)
    .where(
      and(
        eq(ssrVersionTable.id, versionId),
        eq(ssrVersionTable.entityId, entityId),
      ),
    );
  if (!draft || draft.status !== "draft") {
    throw new HTTPException(409, { message: "Version is not an open draft" });
  }
  // The status check sits in the UPDATE: a decision or sync that committed
  // after the read above must not be overwritten (lost update).
  const rejected = await db
    .update(ssrVersionTable)
    .set({ status: "rejected", approvedBy: owner, approvedAt: new Date() })
    .where(
      and(
        eq(ssrVersionTable.id, versionId),
        eq(ssrVersionTable.status, "draft"),
      ),
    )
    .returning({ id: ssrVersionTable.id });
  if (rejected.length === 0) throw notOpenDraft();
  return { entityId, versionId };
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
