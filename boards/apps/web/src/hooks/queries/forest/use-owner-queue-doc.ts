import { useQuery } from "@tanstack/react-query";
import getOwnerQueueDoc from "@/fetchers/forest/get-owner-queue-doc";
import type { OwnerQueueCollection } from "@/fetchers/forest/list-owner-queue";
import { forestKeys } from "./forest-keys";
import { isFinalOwnerQueueError } from "./use-owner-queue";

// One queue document with its answer, both journals and file metadata; it
// loads only when its row opens.
function useOwnerQueueDoc(
  workspaceId: string,
  collection: OwnerQueueCollection,
  id: string | null,
) {
  return useQuery({
    queryKey: [
      ...forestKeys.all(workspaceId),
      "owner-queue-doc",
      collection,
      id,
    ],
    queryFn: () => getOwnerQueueDoc(workspaceId, collection, id ?? ""),
    enabled: Boolean(workspaceId && id),
    retry: (count, error) => !isFinalOwnerQueueError(error) && count < 2,
  });
}

export default useOwnerQueueDoc;
