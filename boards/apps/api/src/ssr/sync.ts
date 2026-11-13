import { createHash } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import db from "../database";
import {
  ssrBlobTable,
  ssrEntityTable,
  ssrPushStateTable,
  ssrVersionTable,
} from "../database/ssr-schema";
import { entityOfPath, isCorpusPath } from "./corpus";
import { knownShas } from "./known-shas";
import { replaceOpenDraft } from "./replace-open-draft";
import { scanSecrets } from "./secret-scan";
import { versionCommit } from "./version-commit";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

export type SyncFile = {
  path: string;
  sha256: string;
  content?: string;
  commitSha?: string;
};

export type SyncResult = {
  commitSha: string;
  created: Array<{
    entity: string;
    kind: string;
    versionId: string;
    number: number;
    status: string;
  }>;
  bumped: Array<{
    entity: string;
    kind: string;
    versionId: string;
    number: number;
  }>;
  archived: string[];
  unchanged: number;
  secretHits: Array<{ path: string; label: string }>;
};

// Aggregate hash of a snapshot: the version identity for RU-5 immutability.
function snapshotSha(files: Array<{ path: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256(sorted.map((file) => `${file.path}:${file.sha256}`).join("\n"));
}

// One sync round (spec RU-3, RU-7, D-005): the Mac agent sends the corpus
// manifest at a git commit plus the content of files whose sha the server has
// not seen. Existing entities auto-bump (Q-014: a merge into main IS the
// owner's consent); new entities wait as drafts for the owner (Q-015).
export async function syncCorpus(
  workspaceId: string,
  input: { commitSha: string; files: SyncFile[]; deleted?: string[] },
  actor: string,
): Promise<SyncResult> {
  const outside = input.files
    .concat((input.deleted ?? []).map((path) => ({ path, sha256: "" })))
    .filter((file) => !isCorpusPath(file.path))
    .map((file) => file.path);
  if (outside.length > 0) {
    throw new SyncError(
      `Paths outside the SSR corpus: ${outside.slice(0, 5).join(", ")}`,
      "corpus_allowlist",
    );
  }

  // The sha names the bytes: blobs are shared between workspaces, so bytes
  // stored under a wrong sha would be served to every workspace that names
  // that sha (TB-92).
  const forged = input.files.filter(
    (file) =>
      file.content !== undefined && sha256(file.content) !== file.sha256,
  );
  if (forged.length > 0) {
    throw new SyncError(
      `Content does not match its sha256: ${forged
        .slice(0, 5)
        .map((file) => file.path)
        .join(", ")}`,
      "sha_mismatch",
    );
  }

  const secretHits = scanSecrets(
    input.files.filter((file) => file.content !== undefined) as Array<{
      path: string;
      content: string;
    }>,
  );
  if (secretHits.length > 0) {
    throw new SyncError(
      `Secret patterns blocked the sync: ${secretHits.map((hit) => `${hit.path} (${hit.label})`).join(", ")}`,
      "secret_scan",
    );
  }

  // A file without content reuses a blob that this workspace already holds
  // (TB-86). Other shas need their bytes: else the version reads a blob of
  // another workspace, or names a blob that never arrives.
  const contentless = input.files.filter((file) => file.content === undefined);
  if (contentless.length > 0) {
    const held = new Set(
      await knownShas(
        workspaceId,
        contentless.map((file) => file.sha256),
      ),
    );
    const missing = contentless.filter((file) => !held.has(file.sha256));
    if (missing.length > 0) {
      throw new SyncError(
        `Content required for files new to this workspace: ${missing
          .slice(0, 5)
          .map((file) => file.path)
          .join(", ")}`,
        "missing_content",
      );
    }
  }

  const knownBlobs = new Set(
    (
      await db
        .select({ sha256: ssrBlobTable.sha256 })
        .from(ssrBlobTable)
        .where(
          inArray(
            ssrBlobTable.sha256,
            input.files.map((file) => file.sha256),
          ),
        )
    ).map((row) => row.sha256),
  );

  const result: SyncResult = {
    commitSha: input.commitSha,
    created: [],
    bumped: [],
    archived: [],
    unchanged: 0,
    secretHits: [],
  };

  await db.transaction(async (tx) => {
    const newBlobs = [
      ...input.files
        .filter(
          (file) => file.content !== undefined && !knownBlobs.has(file.sha256),
        )
        // two empty files share the empty-string sha; a multi-row insert
        // would hit ssr_blob_pkey twice in one statement
        .reduce(
          (bySha, file) => bySha.set(file.sha256, file),
          new Map<string, SyncFile>(),
        )
        .values(),
    ];
    if (newBlobs.length > 0) {
      // Blobs are shared: another workspace's sync can store the same sha
      // between the read above and this insert.
      await tx
        .insert(ssrBlobTable)
        .values(
          newBlobs.map((file) => ({
            sha256: file.sha256,
            content: file.content as string,
            bytes: Buffer.byteLength(file.content as string, "utf8"),
          })),
        )
        .onConflictDoNothing({ target: ssrBlobTable.sha256 });
    }

    const blobSizes = new Map(
      (
        await db
          .select({ sha256: ssrBlobTable.sha256, bytes: ssrBlobTable.bytes })
          .from(ssrBlobTable)
          .where(
            inArray(
              ssrBlobTable.sha256,
              input.files.map((file) => file.sha256),
            ),
          )
      ).map((row) => [row.sha256, row.bytes]),
    );

    const manifests = new Map(input.files.map((file) => [file.path, file]));
    for (const path of input.deleted ?? []) manifests.delete(path);

    // Group files into entities; a skill is its whole folder (D-008).
    const groups = new Map<
      string,
      { kind: string; name: string; files: typeof input.files }
    >();
    for (const file of manifests.values()) {
      const entity = entityOfPath(file.path);
      if (!entity) continue;
      const group = groups.get(entity.path) ?? {
        kind: entity.kind,
        name: entity.name,
        files: [] as typeof input.files,
      };
      group.files.push(file);
      groups.set(entity.path, group);
    }

    const existingEntities = await tx
      .select()
      .from(ssrEntityTable)
      .where(eq(ssrEntityTable.workspaceId, workspaceId));
    const byPath = new Map(
      existingEntities.map((entity) => [entity.path, entity]),
    );

    for (const [path, group] of groups) {
      const snapshot = group.files
        .map((file) => ({
          path: file.path,
          sha256: file.sha256,
          bytes:
            blobSizes.get(file.sha256) ??
            Buffer.byteLength(file.content ?? "", "utf8"),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const blobSha = snapshotSha(snapshot);
      const commitSha = versionCommit(group.files, input.commitSha);

      const existing = byPath.get(path);
      if (!existing) {
        const [entity] = await tx
          .insert(ssrEntityTable)
          .values({
            workspaceId,
            kind: group.kind,
            name: group.name,
            path,
            status: "active",
          })
          .returning({ id: ssrEntityTable.id });
        if (!entity) throw new Error("entity insert returned nothing");
        const [version] = await tx
          .insert(ssrVersionTable)
          .values({
            entityId: entity.id,
            number: 1,
            blobSha,
            files: snapshot,
            status: "draft",
            origin: "sync",
            commitSha,
            createdBy: actor,
            message: "First draft — waiting for owner approval (Q-015)",
          })
          .returning({ id: ssrVersionTable.id });
        if (!version) throw new Error("version insert returned nothing");
        result.created.push({
          entity: group.name,
          kind: group.kind,
          versionId: version.id,
          number: 1,
          status: "draft",
        });
      } else {
        // The highest version, draft or latest: an entity may still wait as
        // a draft (Q-015) — a re-sync used to insert its number again and
        // hit ssr_version_entity_number_key.
        let current = await highestVersion(tx, existing.id);
        if (current?.status === "draft" && current.blobSha !== blobSha) {
          // The owner has not seen the draft yet (Q-015): the newer corpus
          // replaces it in place instead of stacking numbers.
          const replaced = await replaceOpenDraft(tx, current.id, {
            blobSha,
            files: snapshot,
            commitSha,
            createdBy: actor,
          });
          if (replaced) {
            result.created.push({
              entity: group.name,
              kind: group.kind,
              versionId: current.id,
              number: current.number,
              status: "draft",
            });
            continue;
          }
          // The owner approved or rejected it after it was read: this corpus
          // is a new change on top of that decision, never an edit of it.
          current = await highestVersion(tx, existing.id);
          if (current?.status === "draft") {
            throw new SyncError(
              `A concurrent change touched ${path}; sync again`,
              "concurrent_change",
            );
          }
        }
        const latest = current?.status === "latest" ? current : undefined;
        if (current && current.blobSha === blobSha) {
          result.unchanged += 1;
        } else if (!latest) {
          // Never approved: the owner rejected the newest version
          // (approve.ts) or there is none. The changed corpus waits for the
          // owner again (Q-015) instead of going live, and it is numbered
          // after the highest version — numbering from "latest" reused 1 and
          // hit ssr_version_entity_number_key on every sync.
          const number = (current?.number ?? 0) + 1;
          const [version] = await tx
            .insert(ssrVersionTable)
            .values({
              entityId: existing.id,
              number,
              blobSha,
              files: snapshot,
              status: "draft",
              origin: "sync",
              commitSha,
              createdBy: actor,
              message: "Changed draft — waiting for owner approval (Q-015)",
            })
            .returning({ id: ssrVersionTable.id });
          if (!version) throw new Error("version insert returned nothing");
          result.created.push({
            entity: group.name,
            kind: group.kind,
            versionId: version.id,
            number,
            status: "draft",
          });
        } else {
          await tx
            .update(ssrVersionTable)
            .set({ status: "superseded" })
            .where(eq(ssrVersionTable.id, latest.id));
          const number = latest.number + 1;
          const [version] = await tx
            .insert(ssrVersionTable)
            .values({
              entityId: existing.id,
              number,
              blobSha,
              files: snapshot,
              status: "latest",
              origin: "sync",
              commitSha,
              createdBy: actor,
              message: `Sync ${commitSha.slice(0, 10)}`,
            })
            .returning({ id: ssrVersionTable.id });
          if (!version) throw new Error("version insert returned nothing");
          await tx
            .update(ssrEntityTable)
            .set({
              latestVersionId: version.id,
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(ssrEntityTable.id, existing.id));
          result.bumped.push({
            entity: existing.name,
            kind: existing.kind,
            versionId: version.id,
            number,
          });
        }
      }
    }

    // Entities whose files vanished from the manifest are archived (RU-13).
    for (const entity of existingEntities) {
      if (!groups.has(entity.path) && entity.status === "active") {
        await tx
          .update(ssrEntityTable)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(ssrEntityTable.id, entity.id));
        result.archived.push(entity.path);
      }
    }

    // Per-file push baseline: what the repo looked like at this sync.
    for (const file of input.files) {
      await tx
        .insert(ssrPushStateTable)
        .values({
          workspaceId,
          path: file.path,
          lastSyncedSha: file.sha256,
        })
        .onConflictDoUpdate({
          target: [ssrPushStateTable.workspaceId, ssrPushStateTable.path],
          set: { lastSyncedSha: file.sha256, updatedAt: new Date() },
        });
    }
  });

  return result;
}

async function highestVersion(
  executor: Pick<typeof db, "select">,
  entityId: string,
) {
  const [version] = await executor
    .select()
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.entityId, entityId))
    .orderBy(desc(ssrVersionTable.number))
    .limit(1);
  return version;
}

export class SyncError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
