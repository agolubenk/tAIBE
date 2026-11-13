import { useQuery } from "@tanstack/react-query";
import getCardMemory from "@/fetchers/forest/get-card-memory";
import { forestKeys } from "./forest-keys";

// The memory proxy lives on a Mac that may sleep; the API answers from its copy
// then, so a slow refresh is enough.
function useCardMemory(workspaceId: string, taskId: string, enabled = true) {
  return useQuery({
    queryKey: [...forestKeys.card(workspaceId, taskId), "memory"],
    queryFn: () => getCardMemory(workspaceId, taskId),
    enabled: enabled && Boolean(workspaceId && taskId),
    refetchInterval: 120_000,
  });
}

export default useCardMemory;
