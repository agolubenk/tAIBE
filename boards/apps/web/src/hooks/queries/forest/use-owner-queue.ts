import { keepPreviousData, useQuery } from "@tanstack/react-query";
import listOwnerQueue, {
  type OwnerQueueFilter,
} from "@/fetchers/forest/list-owner-queue";
import { HttpError } from "@/lib/http-error";
import { forestKeys } from "./forest-keys";

// 403 (not the owner), 404 (queue not configured) and 502 (console down) do
// not heal by a retry; the tab says which one it is.
export const isFinalOwnerQueueError = (error: unknown) =>
  error instanceof HttpError && [403, 404, 502].includes(error.status);

// TB-156: one page of the owner's queue. The board revalidates the console's
// lists by ETag, so a refetch on focus costs the console a 304.
function useOwnerQueue(
  workspaceId: string,
  filter: OwnerQueueFilter,
  enabled = true,
) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "owner-queue", filter],
    queryFn: () => listOwnerQueue(workspaceId, filter),
    enabled: enabled && Boolean(workspaceId),
    placeholderData: keepPreviousData,
    retry: (count, error) => !isFinalOwnerQueueError(error) && count < 2,
  });
}

export default useOwnerQueue;
