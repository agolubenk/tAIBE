import { inArray } from "drizzle-orm";
import db from "../database";
import { workspaceTable } from "../database/schema";
import { pushBackConfigured, runNightlyPush } from "../ssr/pushback";
import { pushRepos } from "../ssr/push-repos";

// Nightly push-back (spec RU-9): reconcile the served-latest files of every
// workspace that names its repo in SSR_PUSH_REPOS into that repo (TB-93). Disabled without a token — a missing config
// is a setup state, not an error worth paging anyone for.
export async function runNightlySsrPush(): Promise<{ degraded?: boolean }> {
  if (!pushBackConfigured()) {
    console.log(
      "SSR push-back skipped: SSR_PUSH_GITHUB_TOKEN is not configured",
    );
    return {};
  }
  // TB-93: only the workspaces that name their own repo.
  const repos = pushRepos();
  if (repos.size === 0) {
    console.log(
      process.env.SSR_PUSH_GITHUB_REPO
        ? "SSR push-back skipped: SSR_PUSH_GITHUB_REPO is ignored since TB-93; set SSR_PUSH_REPOS=<workspaceId>=<owner>/<repo>"
        : "SSR push-back skipped: SSR_PUSH_REPOS names no workspace",
    );
    return {};
  }
  let degraded = false;
  const workspaces = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(inArray(workspaceTable.id, [...repos.keys()]));
  for (const workspace of workspaces) {
    try {
      const result = await runNightlyPush(workspace.id);
      if (result.conflicts.length > 0 || (!result.pushed && result.reason)) {
        degraded = true;
        console.warn(
          `SSR push-back workspace ${workspace.id}:`,
          result.reason ?? `${result.conflicts.length} conflicts`,
        );
      }
    } catch (error) {
      degraded = true;
      console.error(`SSR push-back workspace ${workspace.id} failed`, error);
    }
  }
  return { degraded };
}
