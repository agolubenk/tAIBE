import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AddedSourceKind } from "@/components/notebook/added-source-kind";
import removeNotebookSource from "@/fetchers/notebook/remove-notebook-source";
import { notebookKeys } from "@/hooks/queries/notebook/notebook-keys";
import { toast } from "@/lib/toast";

type RemoveSource = { kind: AddedSourceKind; ref: string; title: string };

function useRemoveNotebookSource(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ kind, ref }: RemoveSource) =>
      removeNotebookSource(workspaceId, kind, ref),
    onSuccess: (_, { title }) => {
      toast.success(t("workspace:notebook.sources.toast.removed", { title }));
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: notebookKeys.sources(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: notebookKeys.status(workspaceId),
        }),
      ]);
    },
    onError: (error) => {
      toast.error(
        error.message || t("workspace:notebook.sources.toast.removeError"),
      );
    },
  });
}

export default useRemoveNotebookSource;
