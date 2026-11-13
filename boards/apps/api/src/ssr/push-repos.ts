// TB-93: each workspace pushes into its own product repo. SSR_PUSH_REPOS
// lists `<workspaceId>=<owner>/<repo>` pairs, separated by commas. A
// workspace without a pair is not pushed, so the corpus of one product never
// lands in the main of another. The old SSR_PUSH_GITHUB_REPO named one repo
// for every workspace; it is ignored now (fail-closed).
const PAIR = /^([^\s=,]+)=([\w.-]+\/[\w.-]+)$/;

export function pushRepos(
  raw: string = process.env.SSR_PUSH_REPOS ?? "",
): Map<string, string> {
  const repos = new Map<string, string>();
  for (const part of raw.split(",")) {
    const pair = part.trim();
    if (!pair) continue;
    const match = pair.match(PAIR);
    const [, workspaceId, repo] = match ?? [];
    if (!workspaceId || !repo) {
      console.warn(
        `SSR_PUSH_REPOS: "${pair}" is not <workspaceId>=<owner>/<repo>, skipped`,
      );
      continue;
    }
    if (repos.has(workspaceId)) {
      console.warn(
        `SSR_PUSH_REPOS: workspace ${workspaceId} is named twice, not pushed`,
      );
      repos.set(workspaceId, "");
      continue;
    }
    repos.set(workspaceId, repo);
  }
  for (const [workspaceId, repo] of repos) {
    if (!repo) repos.delete(workspaceId);
  }
  return repos;
}

export function pushRepoOf(workspaceId: string): string | null {
  return pushRepos().get(workspaceId) ?? null;
}
