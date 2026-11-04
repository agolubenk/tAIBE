import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import briefNotebookThread from "@/fetchers/notebook/brief-notebook-thread";
import { notebookKeys } from "@/hooks/queries/notebook/notebook-keys";
import { HttpError } from "@/lib/http-error";
import { toast } from "@/lib/toast";

// The API's refusals in the reader's language: the same reasons the button
// shows when the status already knows them.
const REFUSALS: Record<string, "noModel" | "capped"> = {
  NOTEBOOK_MODEL_NOT_CONFIGURED: "noModel",
  NOTEBOOK_DAILY_LIMIT: "capped",
};

// The brief lands in the thread and counts under the daily cap, so the thread
// and the status (calls today) refresh after it, and after a refusal too.
function useBriefNotebookThread(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refreshStatus = () =>
    queryClient.invalidateQueries({
      queryKey: notebookKeys.status(workspaceId),
    });

  return useMutation({
    mutationFn: (threadId: string) =>
      briefNotebookThread(workspaceId, threadId),
    onSuccess: (data) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: notebookKeys.thread(workspaceId, data.thread.id),
        }),
        queryClient.invalidateQueries({
          queryKey: notebookKeys.threads(workspaceId),
          exact: true,
        }),
        refreshStatus(),
      ]),
    onError: (error) => {
      const refusal =
        error instanceof HttpError ? REFUSALS[error.code ?? ""] : undefined;
      toast.error(
        refusal
          ? t(`workspace:notebook.chat.brief.${refusal}`)
          : error.message || t("workspace:notebook.chat.brief.toastError"),
      );
      return refreshStatus();
    },
  });
}

export default useBriefNotebookThread;
