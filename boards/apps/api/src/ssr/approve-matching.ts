import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";
import {
  type DraftMatch,
  findApprovedTwins,
  lockOpenDrafts,
} from "./draft-matches";

// One owner action approves every listed draft whose bytes the owner already
// approved (see ./draft-matches). Each item names the bytes the owner saw, so
// inside the transaction that approves it the draft must still be an open,
// eligible draft of this workspace with exactly that blob sha, and its twin
// must still qualify; one draft per entity. Any failure rolls it all back.
export class DraftBatchConflict extends Error {
  constructor(readonly versionIds: string[]) {
    super(
      "Nothing was approved: some drafts changed, were decided, or no longer match a version you approved",
    );
  }
}

export type BatchItem = { versionId: string; blobSha: string };

export function provenance(twin: DraftMatch) {
  return `Approved as byte-identical to ${twin.workspaceName} v${twin.number}`;
}

function sentShas(items: BatchItem[]) {
  const sent = new Map<string, string>();
  const contradictory = new Set<string>();
  for (const { versionId, blobSha } of items) {
    const previous = sent.get(versionId);
    if (previous !== undefined && previous !== blobSha) {
      contradictory.add(versionId);
    }
    sent.set(versionId, blobSha);
  }
  return { sent, contradictory };
}

function caseById(ids: string[], value: (id: string) => string): SQL {
  const branches = ids.map((id) => sql`when ${id} then ${value(id)}`);
  return sql`case ${ssrVersionTable.id} ${sql.join(branches, sql` `)} end`;
}

export async function approveMatchingDrafts(
  workspaceId: string,
  items: BatchItem[],
  readable: Map<string, string>,
  owner: string,
) {
  const { sent, contradictory } = sentShas(items);
  const ids = [...sent.keys()];
  return db.transaction(async (tx) => {
    const locked = await lockOpenDrafts(tx, workspaceId, ids);
    const drafts = locked.filter(
      (draft) => draft.blobSha === sent.get(draft.versionId),
    );
    const twins = await findApprovedTwins(tx, drafts, readable, owner);
    const byId = new Map(drafts.map((draft) => [draft.versionId, draft]));
    const entities = new Set<string>();
    const offending = ids.filter((id) => {
      const draft = byId.get(id);
      if (!draft || contradictory.has(id) || !twins.has(id)) return true;
      if (entities.has(draft.entityId)) return true;
      entities.add(draft.entityId);
      return false;
    });
    if (offending.length > 0) throw new DraftBatchConflict(offending);

    // Same writes as approveDraft, set-wise: previous latest → superseded,
    // draft → latest with the owner's approval, entity points at it. The
    // message records which approval vouched for the bytes.
    const entityIds = [...entities];
    const now = new Date();
    await tx
      .update(ssrVersionTable)
      .set({ status: "superseded" })
      .where(
        and(
          inArray(ssrVersionTable.entityId, entityIds),
          eq(ssrVersionTable.status, "latest"),
        ),
      );
    await tx
      .update(ssrVersionTable)
      .set({
        status: "latest",
        approvedBy: owner,
        approvedAt: now,
        message: caseById(ids, (id) => {
          const twin = twins.get(id);
          if (!twin) throw new Error("twin vanished after the check");
          return provenance(twin);
        }),
      })
      .where(
        and(
          inArray(ssrVersionTable.id, ids),
          eq(ssrVersionTable.status, "draft"),
        ),
      );
    await tx
      .update(ssrEntityTable)
      .set({
        // Exactly one batch id per entity (checked above).
        latestVersionId: sql`(select ${ssrVersionTable.id} from ${ssrVersionTable} where ${ssrVersionTable.entityId} = ${ssrEntityTable.id} and ${inArray(ssrVersionTable.id, ids)})`,
        status: "active",
        updatedAt: now,
      })
      .where(inArray(ssrEntityTable.id, entityIds));
    return { approved: ids.length, versionIds: ids };
  });
}
