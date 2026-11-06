import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";

// A draft matches when the caller already approved the same bytes at the
// same corpus path: same entity path, same aggregate blob sha of the files
// map, a latest or superseded version the caller approved themselves. A sync
// auto-bump is consent for its own workspace only, and a version the owner
// rolled away from no longer vouches. Only workspaces in `readable` are
// searched, so a workspace the caller cannot read is invisible here.
type Reader = Pick<typeof db, "select">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OpenDraft = {
  entityId: string;
  versionId: string;
  path: string;
  kind: string;
  blobSha: string;
  // The batch may take it: the entity is not archived, the draft is its
  // highest version, and the entity never rejected these exact bytes.
  eligible: boolean;
};

export type DraftMatch = {
  workspaceId: string;
  workspaceName: string;
  versionId: string;
  number: number;
};

const later = alias(ssrVersionTable, "ssr_later_version");

const isHighest = notExists(
  db
    .select({ one: sql`1` })
    .from(later)
    .where(
      and(
        eq(later.entityId, ssrVersionTable.entityId),
        gt(later.number, ssrVersionTable.number),
      ),
    ),
);

const neverRejected = notExists(
  db
    .select({ one: sql`1` })
    .from(later)
    .where(
      and(
        eq(later.entityId, ssrVersionTable.entityId),
        eq(later.status, "rejected"),
        eq(later.blobSha, ssrVersionTable.blobSha),
      ),
    ),
);

const neverRolledAway = notExists(
  db
    .select({ one: sql`1` })
    .from(later)
    .where(
      and(
        eq(later.entityId, ssrVersionTable.entityId),
        gt(later.number, ssrVersionTable.number),
        eq(later.origin, "rollback"),
      ),
    ),
);

const draftColumns = {
  entityId: ssrEntityTable.id,
  versionId: ssrVersionTable.id,
  path: ssrEntityTable.path,
  kind: ssrEntityTable.kind,
  blobSha: ssrVersionTable.blobSha,
  eligible: sql<boolean>`(${ne(ssrEntityTable.status, "archived")} and ${isHighest} and ${neverRejected})`,
};

export function listOpenDrafts(workspaceId: string): Promise<OpenDraft[]> {
  return db
    .select(draftColumns)
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrEntityTable.id, ssrVersionTable.entityId))
    .where(
      and(
        eq(ssrEntityTable.workspaceId, workspaceId),
        eq(ssrVersionTable.status, "draft"),
      ),
    )
    .orderBy(asc(ssrEntityTable.path), asc(ssrVersionTable.number));
}

// Row-locks the named drafts of this workspace that are still open, until the
// batch commits. A sync, approve or reject that touches one of them waits on
// the lock, and its own UPDATE re-checks status='draft', so it then leaves
// the decided row alone. Twins are re-read in the same transaction but not
// locked.
export function lockOpenDrafts(
  tx: Tx,
  workspaceId: string,
  versionIds: string[],
): Promise<OpenDraft[]> {
  return tx
    .select(draftColumns)
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrEntityTable.id, ssrVersionTable.entityId))
    .where(
      and(
        inArray(ssrVersionTable.id, versionIds),
        eq(ssrEntityTable.workspaceId, workspaceId),
        eq(ssrVersionTable.status, "draft"),
      ),
    )
    .for("update", { of: ssrVersionTable });
}

const twinKey = (path: string, blobSha: string) => `${path}\u0000${blobSha}`;

// The twin of every eligible draft, keyed by the draft's version id.
export async function findApprovedTwins(
  executor: Reader,
  drafts: OpenDraft[],
  readable: Map<string, string>,
  ownerId: string,
): Promise<Map<string, DraftMatch>> {
  const matches = new Map<string, DraftMatch>();
  const eligible = drafts.filter((draft) => draft.eligible);
  if (eligible.length === 0 || readable.size === 0) return matches;
  const rows = await executor
    .select({
      workspaceId: ssrEntityTable.workspaceId,
      path: ssrEntityTable.path,
      versionId: ssrVersionTable.id,
      number: ssrVersionTable.number,
      blobSha: ssrVersionTable.blobSha,
      status: ssrVersionTable.status,
      approvedAt: ssrVersionTable.approvedAt,
    })
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrEntityTable.id, ssrVersionTable.entityId))
    .where(
      and(
        inArray(ssrEntityTable.workspaceId, [...readable.keys()]),
        inArray(ssrEntityTable.path, [...new Set(eligible.map((d) => d.path))]),
        inArray(ssrVersionTable.blobSha, [
          ...new Set(eligible.map((d) => d.blobSha)),
        ]),
        inArray(ssrVersionTable.status, ["latest", "superseded"]),
        isNotNull(ssrVersionTable.approvedAt),
        eq(ssrVersionTable.approvedBy, ownerId),
        neverRolledAway,
      ),
    );

  // One twin per (path, sha): a served latest first, then the newest approval.
  rows.sort(
    (a, b) =>
      Number(b.status === "latest") - Number(a.status === "latest") ||
      (b.approvedAt?.getTime() ?? 0) - (a.approvedAt?.getTime() ?? 0) ||
      a.versionId.localeCompare(b.versionId),
  );
  const byKey = new Map<string, DraftMatch>();
  for (const row of rows) {
    const key = twinKey(row.path, row.blobSha);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      workspaceId: row.workspaceId,
      workspaceName: readable.get(row.workspaceId) ?? "",
      versionId: row.versionId,
      number: row.number,
    });
  }
  for (const draft of eligible) {
    const match = byKey.get(twinKey(draft.path, draft.blobSha));
    if (match) matches.set(draft.versionId, match);
  }
  return matches;
}

export async function withMatches(
  drafts: OpenDraft[],
  readable: Map<string, string>,
  ownerId: string,
) {
  const twins = await findApprovedTwins(db, drafts, readable, ownerId);
  return drafts.map((draft) => ({
    entityId: draft.entityId,
    versionId: draft.versionId,
    path: draft.path,
    kind: draft.kind,
    blobSha: draft.blobSha,
    match: twins.get(draft.versionId) ?? null,
  }));
}
