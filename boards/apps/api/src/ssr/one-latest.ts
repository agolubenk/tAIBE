import { and, eq, inArray, notInArray } from "drizzle-orm";
import type db from "../database";
import { ssrVersionTable } from "../database/ssr-schema";

type Writer = Pick<typeof db, "update">;

// TB-258: one `latest` version per entity, kept by every writer of `latest`
// (approve, batch approve, rollback, sync). There is no unique index for it
// (database/ssr-schema.ts: only `(entity_id, number)` is unique).
//
// Each writer takes its locks in one order (TB-89): the draft, the live
// version, then the entity row. In READ COMMITTED a statement does not see a
// row that another transaction inserted after the statement began. So the
// step "live → superseded" misses a version that a concurrent writer made
// `latest` while this one waited for a lock: an approve that waited behind a
// rollback left the restored version `latest` next to its own.
//
// The fix: after the entity row is locked, the writer runs this statement
// again with a fresh snapshot. The entity lock is held to the commit, so a
// writer that got it before this one has committed, and its `latest` is
// visible here. The last writer of an entity wins, and the entity points at
// its version. A writer that has not reached the entity yet has made no
// committed `latest`. A live row that it holds, this writer waited for in its
// own live step, before the entity: so two writers do not deadlock here.
// Three writers at once on one entity can: Postgres ends one with 40P01, and
// nothing of that one is written.

// The step before the entity: every `latest` version of the entities becomes
// superseded. Not by id from an earlier read: a version that went live after
// that read is live too.
export async function supersedeLatest(tx: Writer, entityIds: string[]) {
  await tx
    .update(ssrVersionTable)
    .set({ status: "superseded" })
    .where(
      and(
        inArray(ssrVersionTable.entityId, entityIds),
        eq(ssrVersionTable.status, "latest"),
      ),
    );
}

// The step after the entity row is locked: every other `latest` version of
// the entities becomes superseded; `keep` are the writer's own versions.
export async function keepOneLatest(
  tx: Writer,
  entityIds: string[],
  keep: string[],
) {
  await tx
    .update(ssrVersionTable)
    .set({ status: "superseded" })
    .where(
      and(
        inArray(ssrVersionTable.entityId, entityIds),
        eq(ssrVersionTable.status, "latest"),
        notInArray(ssrVersionTable.id, keep),
      ),
    );
}
