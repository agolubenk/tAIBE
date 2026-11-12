import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import decideApproval from "@/fetchers/forest/decide-approval";
import { forestKeys } from "@/hooks/queries/forest/forest-keys";
import { toast } from "@/lib/toast";

function useDecideApproval(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: decideApproval,
    // «Да» is applied at once (TB-102 R-12): the answer is consumed, or
    // failed with the reason the card refused.
    onSuccess: (approval) => {
      if (approval.status === "failed") {
        toast.error(
          t("workspace:forest.approvals.toast.failed", {
            reason: approval.failReason ?? "",
          }),
        );
      } else {
        toast.success(
          approval.status === "rejected"
            ? t("workspace:forest.approvals.toast.rejected")
            : t("workspace:forest.approvals.toast.applied"),
        );
      }
      return queryClient.invalidateQueries({
        queryKey: forestKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      toast.error(
        error.message || t("workspace:forest.approvals.toast.decideError"),
      );
    },
  });
}

export default useDecideApproval;
