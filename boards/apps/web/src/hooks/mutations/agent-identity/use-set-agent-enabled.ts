import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import setAgentEnabled from "@/fetchers/agent-identity/set-agent-enabled";
import { agentKeys } from "@/hooks/queries/agent-identity/agent-keys";
import { toast } from "@/lib/toast";

function useSetAgentEnabled() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: string; enabled: boolean }) =>
      setAgentEnabled(agentId, enabled),
    onSuccess: (result) => {
      if (!result.enabled) {
        toast.success(
          t("settings:agentsPage.toast.disabled", {
            count: result.revokedKeys,
          }),
        );
      } else {
        // Enabling a disabled agent moves it to the archive (TB-74).
        toast.success(
          result.archived
            ? t("settings:agentsPage.toast.archived")
            : t("settings:agentsPage.toast.enabled"),
        );
      }
      return queryClient.invalidateQueries({ queryKey: agentKeys.all });
    },
    onError: (error) => {
      toast.error(error.message || t("settings:agentsPage.toast.error"));
    },
  });
}

export default useSetAgentEnabled;
