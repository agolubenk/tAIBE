import type { QueryClient } from "@tanstack/react-query";

// Task details (["task", id]) already loaded for one project. A column that
// becomes final, or stops being final, moves completedAt on its tasks inside
// the database (TB-30); an open card shows the date only after this refetch.
// Only active queries refetch, so a closed card costs nothing until reopened.
export function invalidateProjectTaskDetails(
  client: QueryClient,
  projectId: string,
) {
  return client.invalidateQueries({
    queryKey: ["task"],
    predicate: (query) =>
      query.queryKey.length === 2 &&
      (query.state.data as { projectId?: string } | undefined)?.projectId ===
        projectId,
  });
}
