import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";
import { findApprovedTwins, lockOpenDrafts } from "./draft-matches";

// One owner action approves every listed draft whose bytes the owner already
// approved (see ./draft-matches). The ids come from the UI, so each one is
// re-proven here, inside the transaction that approves it: still an open
// draft of this workspace, still a twin of an approved version in a readable
// workspace, one per entity. Any failure rolls the whole batch back.
export class DraftBatchConflict extends Error {
  constructor(readonly versionIds: string[]) {
    super("Some drafts are no longer open or no longer match");
  }
}

export async function approveMatchingDrafts(
  workspaceId: string,
  versionIds: string[],
  readable: Map<string, string>,
  owner: string,
) {
  const ids = [...new Set(versionIds)];
  return db.transaction(async (tx) => {
    const drafts = await lockOpenDrafts(tx, workspaceId, ids);
    const twins = await findApprovedTwins(tx, drafts, readable);
    const byId = new Map(drafts.map((draft) => [draft.versionId, draft]));
    const entities = new Set<string>();
    const offending = ids.filter((id) => {
      const draft = byId.get(id);
      if (!draft || !twins.has(id) || entities.has(draft.entityId)) {
        return true;
      }
      entities.add(draft.entityId);
      return false;
    });
    if (offending.length > 0) throw new DraftBatchConflict(offending);

    // Same writes as approveDraft, set-wise: previous latest → superseded,
    // draft → latest with the owner's approval, entity points at it.
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
      .set({ status: "latest", approvedBy: owner, approvedAt: now })
      .where(inArray(ssrVersionTable.id, ids));
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
