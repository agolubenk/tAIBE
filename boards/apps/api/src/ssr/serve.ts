import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  ssrBlobTable,
  ssrEntityTable,
  ssrVersionTable,
} from "../database/ssr-schema";

// Serving (spec RU-5, RU-8): resolve latest | -1 | N, verify every blob's
// sha on the way out, and answer with the resolved version id so a "-1"
// answer stays reproducible for the caller.
export type VersionSpec = "latest" | "-1" | number;

export type ServedVersion = {
  versionId: string;
  number: number;
  blobSha: string;
  files: Array<{ path: string; content: string; sha256: string }>;
};

export function parseVersionSpec(
  value: string | number | undefined,
): VersionSpec {
  if (value === undefined || value === "latest" || value === "")
    return "latest";
  if (value === "-1" || value === -1) return "-1";
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new HTTPException(400, {
      message: "version must be 'latest', '-1' or a positive number",
    });
  }
  return parsed;
}

export async function resolveVersion(
  workspaceId: string,
  entityId: string,
  spec: VersionSpec,
) {
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

  const versions = await db
    .select()
    .from(ssrVersionTable)
    .where(eq(ssrVersionTable.entityId, entityId))
    .orderBy(desc(ssrVersionTable.number));
  if (versions.length === 0) {
    throw new HTTPException(404, { message: "Entity has no versions" });
  }

  let version = versions[0];
  if (!version) {
    throw new HTTPException(404, { message: "Entity has no versions" });
  }
  if (spec === "latest") {
    version =
      versions.find((candidate) => candidate.status === "latest") ?? version;
  } else if (spec === "-1") {
    const latestIndex = versions.findIndex(
      (candidate) => candidate.status === "latest",
    );
    const index = latestIndex >= 0 ? latestIndex : 0;
    const previous = versions[index + 1];
    if (!previous) {
      throw new HTTPException(404, { message: "No previous version" });
    }
    version = previous;
  } else {
    const exact = versions.find((candidate) => candidate.number === spec);
    if (!exact) {
      throw new HTTPException(404, { message: `Version ${spec} not found` });
    }
    version = exact;
  }
  return { entity, version };
}

export async function serveVersion(
  workspaceId: string,
  entityId: string,
  spec: VersionSpec,
): Promise<ServedVersion> {
  const { version } = await resolveVersion(workspaceId, entityId, spec);
  const shas = version.files.map((file) => file.sha256);
  const blobs = await db
    .select()
    .from(ssrBlobTable)
    .where(inArray(ssrBlobTable.sha256, shas));
  const bySha = new Map(blobs.map((blob) => [blob.sha256, blob]));

  const files = version.files.map((file) => {
    const blob = bySha.get(file.sha256);
    const actual = blob
      ? createHash("sha256").update(blob.content, "utf8").digest("hex")
      : null;
    if (!blob || actual !== file.sha256) {
      throw new HTTPException(500, {
        message: `Blob integrity failed for ${file.path}: refusing to serve`,
      });
    }
    return { path: file.path, content: blob.content, sha256: file.sha256 };
  });

  return {
    versionId: version.id,
    number: version.number,
    blobSha: version.blobSha,
    files,
  };
}

// Server-side unified diff (spec RU-11): the client receives kilobytes, not
// megabytes. Files beyond the line limit collapse into a summary hunk.
const DIFF_LINE_LIMIT = 4000;

function diffLines(before: string[], after: string[], path: string): string[] {
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  if (before.length + after.length > DIFF_LINE_LIMIT) {
    lines.push(
      `@@ summary @@`,
      `- ${before.length} lines`,
      `+ ${after.length} lines`,
      `(diff suppressed: file larger than ${DIFF_LINE_LIMIT} lines)`,
    );
    return lines;
  }
  // Simple LCS on lines; corpus files are small enough that O(n*m) is fine.
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        before[i] === after[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, lcs[i]?.[j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = before[i] ?? "";
    const right = after[j] ?? "";
    if (left === right) {
      lines.push(` ${left}`);
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push(`-${left}`);
      i += 1;
    } else {
      lines.push(`+${right}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${before[i] ?? ""}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+${after[j] ?? ""}`);
    j += 1;
  }
  return lines;
}

export async function diffVersions(
  workspaceId: string,
  entityId: string,
  fromSpec: VersionSpec,
  toSpec: VersionSpec,
): Promise<{
  from: number;
  to: number;
  toVersionId: string;
  toBlobSha: string;
  files: Array<{ path: string; diff: string }>;
}> {
  const from = await serveVersion(workspaceId, entityId, fromSpec);
  const to = await serveVersion(workspaceId, entityId, toSpec);
  const fromByPath = new Map(
    from.files.map((file) => [file.path, file.content]),
  );
  const paths = [
    ...new Set([...fromByPath.keys(), ...to.files.map((file) => file.path)]),
  ].sort();
  const files = paths.map((path) => {
    const before = (fromByPath.get(path) ?? "").split("\n");
    const after = (
      to.files.find((file) => file.path === path)?.content ?? ""
    ).split("\n");
    return { path, diff: diffLines(before, after, path).join("\n") };
  });
  return {
    from: from.number,
    to: to.number,
    toVersionId: to.versionId,
    toBlobSha: to.blobSha,
    files,
  };
}

export async function listEntities(workspaceId: string) {
  const entities = await db
    .select()
    .from(ssrEntityTable)
    .where(eq(ssrEntityTable.workspaceId, workspaceId))
    .orderBy(asc(ssrEntityTable.kind), asc(ssrEntityTable.name));
  const versions = await db
    .select({
      entityId: ssrVersionTable.entityId,
      id: ssrVersionTable.id,
      number: ssrVersionTable.number,
      status: ssrVersionTable.status,
      origin: ssrVersionTable.origin,
      commitSha: ssrVersionTable.commitSha,
      message: ssrVersionTable.message,
      createdAt: ssrVersionTable.createdAt,
      approvedBy: ssrVersionTable.approvedBy,
      approvedAt: ssrVersionTable.approvedAt,
    })
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrVersionTable.entityId, ssrEntityTable.id))
    .where(eq(ssrEntityTable.workspaceId, workspaceId))
    .orderBy(desc(ssrVersionTable.createdAt));
  return entities.map((entity) => ({
    ...entity,
    versions: versions.filter((version) => version.entityId === entity.id),
  }));
}

export async function timeline(workspaceId: string, take = 100, skip = 0) {
  const rows = await db
    .select({
      versionId: ssrVersionTable.id,
      number: ssrVersionTable.number,
      status: ssrVersionTable.status,
      origin: ssrVersionTable.origin,
      message: ssrVersionTable.message,
      commitSha: ssrVersionTable.commitSha,
      createdAt: ssrVersionTable.createdAt,
      entityId: ssrEntityTable.id,
      entityName: ssrEntityTable.name,
      entityKind: ssrEntityTable.kind,
      entityPath: ssrEntityTable.path,
    })
    .from(ssrVersionTable)
    .innerJoin(ssrEntityTable, eq(ssrVersionTable.entityId, ssrEntityTable.id))
    .where(eq(ssrEntityTable.workspaceId, workspaceId))
    .orderBy(desc(ssrVersionTable.createdAt))
    .limit(Math.min(take, 100))
    .offset(skip);
  return rows;
}
