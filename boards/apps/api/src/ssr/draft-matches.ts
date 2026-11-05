import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import db from "../database";
import { ssrEntityTable, ssrVersionTable } from "../database/ssr-schema";

// A draft "matches" when a version the owner already approved holds the same
// bytes at the same corpus path: same entity path, same aggregate blob sha of
// the files map, status latest or superseded and either an owner approval or
// a sync auto-bump (a merge into main is consent, Q-014). Drafts and rejected
// versions never vouch. Only workspaces in `readable` are searched, so a
// workspace the caller cannot read is invisible here.
type Executor = Pick<typeof db, "select">;

export type OpenDraft = {
  entityId: string;
  versionId: string;
  path: string;
  kind: string;
  blobSha: string;
};

export type DraftMatch = {
  workspaceId: string;
  workspaceName: string;
  versionId: string;
  number: number;
};

const draftColumns = {
  entityId: ssrEntityTable.id,
  versionId: ssrVersionTable.id,
  path: ssrEntityTable.path,
  kind: ssrEntityTable.kind,
  blobSha: ssrVersionTable.blobSha,
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

// Row-locks the named drafts of this workspace that are still open, so a
// concurrent sync or single decision cannot change them under the batch.
export function lockOpenDrafts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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

export async function findApprovedTwins(
  executor: Executor,
  drafts: OpenDraft[],
  readable: Map<string, string>,
): Promise<Map<string, DraftMatch>> {
  const matches = new Map<string, DraftMatch>();
  if (drafts.length === 0 || readable.size === 0) return matches;
  const rows = await executor
    .select({
      workspaceId: ssrEntityTable.workspaceId,
      path: ssrEntityTable.path,
      versionId: ssrVersionTable.id,
      number: ssrVersionTable.number,
      blobSha: ssrVersionTable.blobSha,
      status: ssrVersionTable.status,
      createdAt: ssrVersionTable.createdAt,
    })
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrEntityTable.id, ssrVersionTable.entityId))
    .where(
      and(
        inArray(ssrEntityTable.workspaceId, [...readable.keys()]),
        inArray(ssrEntityTable.path, [...new Set(drafts.map((d) => d.path))]),
        inArray(ssrVersionTable.blobSha, [
          ...new Set(drafts.map((d) => d.blobSha)),
        ]),
        inArray(ssrVersionTable.status, ["latest", "superseded"]),
        or(
          isNotNull(ssrVersionTable.approvedAt),
          eq(ssrVersionTable.origin, "sync"),
        ),
      ),
    );

  // One twin per (path, sha): a served latest first, then the newest.
  rows.sort(
    (a, b) =>
      Number(b.status === "latest") - Number(a.status === "latest") ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
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
  for (const draft of drafts) {
    const match = byKey.get(twinKey(draft.path, draft.blobSha));
    if (match) matches.set(draft.versionId, match);
  }
  return matches;
}

export async function listDraftMatches(
  workspaceId: string,
  readable: Map<string, string>,
) {
  const drafts = await listOpenDrafts(workspaceId);
  const twins = await findApprovedTwins(db, drafts, readable);
  return drafts.map((draft) => ({
    entityId: draft.entityId,
    versionId: draft.versionId,
    path: draft.path,
    kind: draft.kind,
    match: twins.get(draft.versionId) ?? null,
  }));
}
