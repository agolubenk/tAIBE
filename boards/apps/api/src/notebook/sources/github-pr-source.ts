import { and, eq, isNull } from "drizzle-orm";
import db from "../../database";
import { integrationTable, projectTable } from "../../database/schema";
import { ApiError } from "../../errors/api-error";
import {
  type GitHubConfig,
  hasVerifiedGitHubBinding,
} from "../../plugins/github/config";
import { getVerifiedInstallationOctokit } from "../../plugins/github/utils/github-app";
import { SOURCE_TEXT_MAX } from "../routes/schema";
import { type PullRequestRef, parsePullRequestRef } from "./github-pr-ref";
import {
  PR_COMMENTS_MAX,
  pullRequestText,
  pullRequestTitle,
} from "./github-pr-text";
import { openToEveryMember } from "./open-to-every-member";
import { upsertSource } from "./upsert-source";

const GITHUB_TIMEOUT_MS = 10_000;

function parseConfig(raw: string): GitHubConfig | null {
  try {
    return JSON.parse(raw) as GitHubConfig;
  } catch {
    return null;
  }
}

// The workspace's own verified binding to the repo, from a project every
// member may open: the PR text is then shared with readers who already see
// that repo's cards, and the App's token is never spent on a repo this
// workspace did not link.
async function linkedRepository(workspaceId: string, pr: PullRequestRef) {
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
  const name = `${pr.owner}/${pr.repo}`.toLowerCase();
  for (const row of rows) {
    const config = parseConfig(row.config);
    if (
      config &&
      hasVerifiedGitHubBinding(config) &&
      `${config.repositoryOwner}/${config.repositoryName}`.toLowerCase() ===
        name
    ) {
      return config;
    }
  }
  throw new ApiError(422, {
    code: "PR_REPO_NOT_LINKED",
    message: `No project open to every member of this workspace links ${pr.owner}/${pr.repo} through a verified GitHub integration.`,
  });
}

async function connect(config: GitHubConfig) {
  try {
    return await getVerifiedInstallationOctokit(config, true);
  } catch (error) {
    if (error instanceof Error && error.message === "GitHub App not configured")
      throw new ApiError(503, {
        code: "GITHUB_APP_NOT_CONFIGURED",
        message: "The GitHub App is not configured on this instance.",
      });
    throw githubUnavailable(config);
  }
}

function githubUnavailable(config: GitHubConfig) {
  return new ApiError(502, {
    code: "GITHUB_UNAVAILABLE",
    message: `GitHub did not answer for ${config.repositoryOwner}/${config.repositoryName}. Try again, or reconnect the integration.`,
  });
}

const status = (error: unknown) =>
  (error as { status?: unknown } | null)?.status;

async function readPullRequest(config: GitHubConfig, number: number) {
  const octokit = await connect(config);
  const repo = { owner: config.repositoryOwner, repo: config.repositoryName };
  try {
    const [{ data: pr }, { data: comments }] = await Promise.all([
      octokit.rest.pulls.get({
        ...repo,
        pull_number: number,
        request: { timeout: GITHUB_TIMEOUT_MS },
      }),
      octokit.rest.issues.listComments({
        ...repo,
        issue_number: number,
        per_page: PR_COMMENTS_MAX,
        request: { timeout: GITHUB_TIMEOUT_MS },
      }),
    ]);
    return { pr, comments };
  } catch (error) {
    if (status(error) === 404) {
      throw new ApiError(404, {
        code: "PR_NOT_FOUND",
        message: `Pull request #${number} was not found in ${repo.owner}/${repo.repo}.`,
      });
    }
    throw githubUnavailable(config);
  }
}

// Adding the same PR again ("Refresh") re-reads it and replaces its text.
export async function addPullRequestSource(workspaceId: string, input: string) {
  const ref = parsePullRequestRef(input);
  const config = await linkedRepository(workspaceId, ref);
  const { pr, comments } = await readPullRequest(config, ref.number);
  const title = pullRequestTitle(ref.ref, pr);
  const stored = await upsertSource({
    workspaceId,
    kind: "github-pr",
    ref: ref.ref,
    title,
    text: pullRequestText(ref.ref, pr, comments).slice(0, SOURCE_TEXT_MAX),
  });
  return { ...stored, kind: "github-pr" as const, ref: ref.ref, title };
}
