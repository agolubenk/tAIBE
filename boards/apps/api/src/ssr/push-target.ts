// TB-160: the repo and branch that a workspace's approved versions are pushed
// to. The server holds one GitHub token, so the target is the operator's
// config (SSR_PUSH_TARGETS, the form of OQ_WORKSPACE_PRODUCTS), never the
// workspace's own data: workspace.metadata is edited by the workspace's
// admins. A workspace without a target is not pushed. There is no default:
// it was HR_Helper-v2 main for every workspace, and the corpus paths of two
// products are the same.
export type PushTarget = { repo: string; branch: string };

// owner/repo; "." and ".." are not names (a URL path would fold them).
const REPO = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
// A branch goes into the URL path (git/ref/heads/<branch>): segments of safe
// characters, none starting with a dot, no "..".
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const LEGACY = ["SSR_PUSH_GITHUB_REPO", "SSR_PUSH_GITHUB_BRANCH"];

const validBranch = (branch: string) =>
  !branch.includes("..") &&
  branch.split("/").every((segment) => SEGMENT.test(segment));

// SSR_PUSH_TARGETS=<workspaceId>=<owner>/<repo>@<branch>,… A malformed entry,
// or a workspace named twice, is left out with one log line: a push to a
// guessed repo is worse than none.
export function readPushTargets(
  env: Record<string, string | undefined> = process.env,
): Map<string, PushTarget> {
  const targets = new Map<string, PushTarget>();
  const left = new Set<string>();
  for (const entry of (env.SSR_PUSH_TARGETS ?? "").split(",")) {
    if (!entry.trim()) continue;
    const [workspaceId = "", target = "", ...extra] = entry
      .split("=")
      .map((part) => part.trim());
    const [repo = "", branch = "", ...more] = target.split("@");
    const valid =
      workspaceId !== "" &&
      extra.length === 0 &&
      more.length === 0 &&
      REPO.test(repo) &&
      validBranch(branch);
    if (!valid || targets.has(workspaceId) || left.has(workspaceId)) {
      left.add(workspaceId || "(no workspace id)");
      targets.delete(workspaceId);
      continue;
    }
    targets.set(workspaceId, { repo, branch });
  }
  if (left.size > 0) {
    console.warn(
      `SSR push-back: SSR_PUSH_TARGETS entries left out (malformed or repeated): ${[...left].join(", ")}`,
    );
  }
  const legacy = LEGACY.filter((name) => env[name]);
  if (legacy.length > 0) {
    console.warn(
      `SSR push-back: ${legacy.join(", ")} ignored; the target is set per workspace in SSR_PUSH_TARGETS (TB-160)`,
    );
  }
  return targets;
}
