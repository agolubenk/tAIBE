import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import requestPullRequestReview from "@/fetchers/external-link/request-pull-request-review";
import {
  getReviewErrorKey,
  shouldRefetchAfterReviewError,
} from "@/lib/pull-request-review";
import { toast } from "@/lib/toast";
import type { ExternalLink } from "@/types/external-link";

export default function useRequestPullRequestReview() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: requestPullRequestReview,
    // The answer is the updated link: no second request on a slow network.
    onSuccess: (link, { taskId, id }) =>
      queryClient.setQueryData<ExternalLink[]>(
        ["external-links", taskId],
        (links) =>
          links?.map((item) =>
            item.id === id ? { ...item, ...link, id: item.id } : item,
          ),
      ),
    onError: (error, { taskId }) => {
      toast.error(t(getReviewErrorKey(error)));
      if (shouldRefetchAfterReviewError(error)) {
        queryClient.invalidateQueries({ queryKey: ["external-links", taskId] });
      }
    },
  });
}
