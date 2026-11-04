import { and, eq, isNull } from "drizzle-orm";
import db from "../../database";
import { notebookSourceTable } from "../../database/notebook-schema";
import { integrationTable, projectTable } from "../../database/schema";
import {
  type GitHubConfig,
  hasVerifiedGitHubBinding,
} from "../../plugins/github/config";
import { deleteSources, SOURCES_MAX } from "./list-sources";
import { openToEveryMember } from "./open-to-every-member";

function parseConfig(raw: string): GitHubConfig | null {
  try {
    return JSON.parse(raw) as GitHubConfig;
  } catch {
    return null;
  }
}

export const repositoryKey = (owner: string, repo: string) =>
  `${owner}/${repo}`.toLowerCase();

// The workspace's verified GitHub bindings from active projects every member
// may open, by lower-case owner/repo. A PR is read, and kept, only through
// one: its text is then shared with readers who already see that repo's
// cards, and the App's token is never spent on a repo the workspace did not
// link.
export async function linkedRepositories(workspaceId: string) {
  const rows = await db
    .select({ config: integrationTable.config })
    .from(integrationTable)
    .innerJoin(projectTable, eq(integrationTable.projectId, projectTable.id))
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
        eq(integrationTable.type, "github"),
        eq(integrationTable.isActive, true),
        openToEveryMember,
      ),
    );
  const linked = new Map<string, GitHubConfig>();
  for (const row of rows) {
    const config = parseConfig(row.config);
    if (config && hasVerifiedGitHubBinding(config)) {
      linked.set(
        repositoryKey(config.repositoryOwner, config.repositoryName),
        config,
      );
    }
  }
  return linked;
}

// A project that becomes restricted or archived, or an integration that is
// removed, takes its PRs out of the notebook on the next sync, as it does
// with the project's cards.
export async function pruneUnlinkedPullRequests(workspaceId: string) {
  const linked = await linkedRepositories(workspaceId);
  const stored = await db
    .select({ ref: notebookSourceTable.ref })
    .from(notebookSourceTable)
    .where(
      and(
        eq(notebookSourceTable.workspaceId, workspaceId),
        eq(notebookSourceTable.kind, "github-pr"),
      ),
    )
    .limit(SOURCES_MAX);
  const gone = stored
    .map(({ ref }) => ref)
    .filter((ref) => !linked.has(ref.slice(0, ref.lastIndexOf("#"))));
  return deleteSources(workspaceId, "github-pr", gone);
}
