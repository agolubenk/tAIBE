import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AddedSourceKind } from "@/components/notebook/added-source-kind";
import { sourceErrorCode } from "@/components/notebook/source-error-code";
import addNotebookLink from "@/fetchers/notebook/add-notebook-link";
import addNotebookPullRequest from "@/fetchers/notebook/add-notebook-pull-request";
import { notebookKeys } from "@/hooks/queries/notebook/notebook-keys";
import { toast } from "@/lib/toast";

type AddSource = { kind: AddedSourceKind; url: string };

// Adding a link or a PR that is already there refreshes it, so one mutation
// serves both the form and the refresh button of a row.
function useAddNotebookSource(workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ kind, url }: AddSource) =>
      kind === "github-pr"
        ? addNotebookPullRequest(workspaceId, url)
        : addNotebookLink(workspaceId, url),
    onSuccess: (source) => {
      toast.success(
        source.changed
          ? t("workspace:notebook.sources.toast.added", { title: source.title })
          : t("workspace:notebook.sources.toast.unchanged", {
              title: source.title,
            }),
      );
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
      const code = sourceErrorCode(error);
      toast.error(
        code
          ? t(`workspace:notebook.sources.errors.${code}`)
          : error.message || t("workspace:notebook.sources.toast.error"),
      );
    },
  });
}

export default useAddNotebookSource;
