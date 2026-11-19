import db from "../database";
import { workspaceTable } from "../database/schema";
import { readPushTargets } from "../ssr/push-target";
import { pushBackConfigured, runNightlyPush } from "../ssr/pushback";

// Nightly push-back (spec RU-9): reconcile the served-latest files of every
// workspace with a target (SSR_PUSH_TARGETS, TB-160) into its own repo.
// Disabled without a token or a target — a missing config is a setup state,
// not an error worth paging anyone for.
export async function runNightlySsrPush(): Promise<{ degraded?: boolean }> {
  if (!pushBackConfigured()) {
    console.log(
      "SSR push-back skipped: SSR_PUSH_GITHUB_TOKEN is not configured",
    );
    return {};
  }
  const targets = readPushTargets();
  if (targets.size === 0) {
    console.log("SSR push-back skipped: SSR_PUSH_TARGETS names no workspace");
    return {};
  }
  let degraded = false;
  let untargeted = 0;
  const workspaces = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable);
  for (const workspace of workspaces) {
    if (!targets.has(workspace.id)) {
      untargeted += 1;
      continue;
    }
    try {
      const result = await runNightlyPush(workspace.id, targets);
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
  if (untargeted > 0) {
    console.log(
      `SSR push-back: ${untargeted} workspace(s) without a target in SSR_PUSH_TARGETS, not pushed`,
    );
  }
  return { degraded };
}
