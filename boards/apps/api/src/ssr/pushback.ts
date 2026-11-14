import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../database";
import {
  ssrBlobTable,
  ssrConflictTable,
  ssrEntityTable,
  ssrPushStateTable,
  ssrVersionTable,
} from "../database/ssr-schema";
import { isCorpusPath } from "./corpus";

// Push-back (spec RU-9, D-010, D-012): commits served-latest files into the
// product repo's main with [skip ci]. The push is conditional — for every
// file the repo's current sha must equal what the sync last saw; anything
// else is a conflict row, never a silent overwrite. Rollbacks push
// immediately; the nightly job only reconciles what drifted.
const REPO = process.env.SSR_PUSH_GITHUB_REPO ?? "agolubenk/HR_Helper-v2";
const BRANCH = process.env.SSR_PUSH_GITHUB_BRANCH ?? "main";
const API = "https://api.github.com";

type ChangesetFile = { path: string; sha256: string; content: string };
// content is null when no blob holds the sha that the served version names.
type ChangesetEntry = { path: string; sha256: string; content: string | null };

const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// TB-94. The sha names the bytes that go into the product repo: a blob that is
// missing or does not hash to its sha (bytes stored before the TB-92 sync
// check, a damaged row) must not be committed under the version's name.
export function blobIntegrityFailures(changeset: ChangesetEntry[]): string[] {
  return changeset
    .filter(
      (file) =>
        file.content === null || sha256Hex(file.content) !== file.sha256,
    )
    .map((file) => file.path);
}

export type PushResult = {
  pushed: boolean;
  commitSha: string | null;
  files: string[];
  conflicts: Array<{ path: string; baselineSha: string; repoSha: string }>;
  reason?: string;
};

export function pushBackConfigured(): boolean {
  return Boolean(process.env.SSR_PUSH_GITHUB_TOKEN);
}

function github(path: string, init: RequestInit = {}) {
  const token = process.env.SSR_PUSH_GITHUB_TOKEN;
  if (!token) throw new Error("SSR_PUSH_GITHUB_TOKEN is not configured");
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

type RepoFile = { sha: string | null; content: string | null };

async function readRepoFiles(paths: string[]): Promise<Map<string, RepoFile>> {
  const result = new Map<string, RepoFile>();
  for (const path of paths) {
    const response = await github(
      `/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`,
    );
    if (response.status === 404) {
      result.set(path, { sha: null, content: null });
      continue;
    }
    if (!response.ok) {
      throw new Error(`GitHub contents ${path}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      sha?: string;
      content?: string;
      encoding?: string;
    };
    const content =
      body.encoding === "base64" && body.content
        ? Buffer.from(body.content, "base64").toString("utf8")
        : null;
    result.set(path, { sha: body.sha ?? null, content });
  }
  return result;
}

// The files that differ between the repo and the served latest versions.
export async function collectChangeset(
  workspaceId: string,
): Promise<ChangesetEntry[]> {
  const entities = await db
    .select()
    .from(ssrEntityTable)
    .where(
      and(
        eq(ssrEntityTable.workspaceId, workspaceId),
        eq(ssrEntityTable.status, "active"),
      ),
    );
  const latestIds = entities
    .map((entity) => entity.latestVersionId)
    .filter((id): id is string => Boolean(id));
  if (latestIds.length === 0) return [];

  const versions = await db
    .select()
    .from(ssrVersionTable)
    .where(inArray(ssrVersionTable.id, latestIds));
  const states = await db
    .select()
    .from(ssrPushStateTable)
    .where(eq(ssrPushStateTable.workspaceId, workspaceId));
  const pushedByPath = new Map(states.map((state) => [state.path, state]));

  const wanted = new Map<string, string>(); // path -> sha
  for (const version of versions) {
    for (const file of version.files) wanted.set(file.path, file.sha256);
  }
  // Files whose served sha already matches the last push need no work.
  for (const [path, sha] of wanted) {
    if (pushedByPath.get(path)?.lastPushedSha === sha) wanted.delete(path);
  }
  if (wanted.size === 0) return [];

  const blobs = await db
    .select()
    .from(ssrBlobTable)
    .where(inArray(ssrBlobTable.sha256, [...wanted.values()]));
  const blobBySha = new Map(blobs.map((blob) => [blob.sha256, blob]));

  // A missing blob stays in the changeset: the push refuses it loudly instead
  // of skipping the file every night without a word.
  return [...wanted].map(([path, sha]) => ({
    path,
    sha256: sha,
    content: blobBySha.get(sha)?.content ?? null,
  }));
}

export async function pushChangeset(
  workspaceId: string,
  message: string,
  filterPaths?: string[],
): Promise<PushResult> {
  if (!pushBackConfigured()) {
    return {
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
      reason: "not_configured",
    };
  }
  let changeset = await collectChangeset(workspaceId);
  if (filterPaths) {
    const allow = new Set(filterPaths);
    changeset = changeset.filter((file) => allow.has(file.path));
  }
  if (changeset.length === 0) {
    return { pushed: false, commitSha: null, files: [], conflicts: [] };
  }

  // Allowlist guard: a path outside the corpus aborts the whole push (RU-9).
  const outside = changeset.filter((file) => !isCorpusPath(file.path));
  if (outside.length > 0) {
    return {
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
      reason: `allowlist_violation: ${outside[0]?.path ?? outside.length} path(s)`,
    };
  }

  // Integrity guard (TB-94): one bad blob aborts the whole push before any
  // GitHub call, like the allowlist guard; the paths go to the server log.
  const broken = blobIntegrityFailures(changeset);
  if (broken.length > 0) {
    console.error(
      `SSR push-back workspace ${workspaceId}: blob integrity failed, push aborted: ${broken.slice(0, 5).join(", ")}`,
    );
    return {
      pushed: false,
      commitSha: null,
      files: [],
      conflicts: [],
      reason: `blob_integrity: ${broken.length} file(s), first ${broken[0]}`,
    };
  }
  const files = changeset.filter(
    (file): file is ChangesetFile => file.content !== null,
  );

  const repoFiles = await readRepoFiles(files.map((file) => file.path));
  const states = await db
    .select()
    .from(ssrPushStateTable)
    .where(
      and(
        eq(ssrPushStateTable.workspaceId, workspaceId),
        inArray(
          ssrPushStateTable.path,
          files.map((file) => file.path),
        ),
      ),
    );
  const baselineByPath = new Map(states.map((state) => [state.path, state]));

  // Conditional push (D-012): repo sha must equal the sync's baseline.
  const conflicts: PushResult["conflicts"] = [];
  const toPush: ChangesetFile[] = [];
  for (const file of files) {
    const repo = repoFiles.get(file.path);
    // git's blob sha is not our content sha; compare content hashes.
    const baseline = baselineByPath.get(file.path)?.lastSyncedSha ?? null;
    const repoContentSha = repo?.content ? sha256Hex(repo.content) : null;
    if (
      repoContentSha !== null &&
      baseline !== null &&
      repoContentSha !== baseline
    ) {
      conflicts.push({
        path: file.path,
        baselineSha: baseline,
        repoSha: repoContentSha,
      });
      continue;
    }
    toPush.push(file);
  }

  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      await db.insert(ssrConflictTable).values({
        workspaceId,
        path: conflict.path,
        baselineSha: conflict.baselineSha,
        repoSha: conflict.repoSha,
      });
    }
  }
  if (toPush.length === 0) {
    return { pushed: false, commitSha: null, files: [], conflicts };
  }

  const commitSha = await commitFiles(message, toPush);
  await db
    .insert(ssrPushStateTable)
    .values(
      toPush.map((file) => ({
        workspaceId,
        path: file.path,
        lastSyncedSha: file.sha256,
        lastPushedSha: file.sha256,
        lastPushedCommitSha: commitSha,
      })),
    )
    .onConflictDoUpdate({
      target: [ssrPushStateTable.workspaceId, ssrPushStateTable.path],
      set: {
        lastSyncedSha: sql.raw("excluded.last_synced_sha"),
        lastPushedSha: sql.raw("excluded.last_pushed_sha"),
        lastPushedCommitSha: sql.raw("excluded.last_pushed_commit_sha"),
        updatedAt: new Date(),
      },
    });

  return {
    pushed: true,
    commitSha,
    files: toPush.map((file) => file.path),
    conflicts,
  };
}

async function commitFiles(
  message: string,
  files: ChangesetFile[],
): Promise<string> {
  const refResponse = await github(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
  if (!refResponse.ok) {
    throw new Error(`GitHub ref: HTTP ${refResponse.status}`);
  }
  const ref = (await refResponse.json()) as { object: { sha: string } };
  const commitResponse = await github(
    `/repos/${REPO}/git/commits/${ref.object.sha}`,
  );
  if (!commitResponse.ok) {
    throw new Error(`GitHub commit: HTTP ${commitResponse.status}`);
  }
  const commit = (await commitResponse.json()) as { tree: { sha: string } };

  const treeItems = await Promise.all(
    files.map(async (file) => {
      const blobResponse = await github(`/repos/${REPO}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      });
      if (!blobResponse.ok) {
        throw new Error(
          `GitHub blob ${file.path}: HTTP ${blobResponse.status}`,
        );
      }
      const blob = (await blobResponse.json()) as { sha: string };
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }),
  );

  const treeResponse = await github(`/repos/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: treeItems }),
  });
  if (!treeResponse.ok) {
    throw new Error(`GitHub tree: HTTP ${treeResponse.status}`);
  }
  const tree = (await treeResponse.json()) as { sha: string };

  const newCommitResponse = await github(`/repos/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `${message} [skip ci]`,
      tree: tree.sha,
      parents: [ref.object.sha],
    }),
  });
  if (!newCommitResponse.ok) {
    throw new Error(`GitHub commit create: HTTP ${newCommitResponse.status}`);
  }
  const newCommit = (await newCommitResponse.json()) as { sha: string };

  const updateResponse = await github(
    `/repos/${REPO}/git/refs/heads/${BRANCH}`,
    {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha }),
    },
  );
  if (!updateResponse.ok) {
    throw new Error(`GitHub ref update: HTTP ${updateResponse.status}`);
  }
  return newCommit.sha;
}

// Nightly reconcile (scheduler): push whatever drifted, record conflicts.
export async function runNightlyPush(workspaceId: string): Promise<PushResult> {
  return pushChangeset(workspaceId, "tAI-Boards SSR: sync approved versions");
}
