import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import useAddNotebookSource from "@/hooks/mutations/notebook/use-add-notebook-source";
import { cn } from "@/lib/cn";
import type { AddedSourceKind } from "./added-source-kind";

type RefreshSourceButtonProps = {
  workspaceId: string;
  kind: AddedSourceKind;
  ref_: string;
  title: string;
};

// The ref of a link is its URL and the PR route takes owner/repo#n, so a
// refresh sends the ref back to the route that added it.
export function RefreshSourceButton({
  workspaceId,
  kind,
  ref_,
  title,
}: RefreshSourceButtonProps) {
  const { t } = useTranslation();
  const refresh = useAddNotebookSource(workspaceId);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t("workspace:notebook.sources.refresh", { title })}
      title={t("workspace:notebook.sources.refresh", { title })}
      disabled={refresh.isPending}
      onClick={() => refresh.mutate({ kind, url: ref_ })}
    >
      <RefreshCw
        aria-hidden="true"
        className={cn(refresh.isPending && "animate-spin")}
      />
    </Button>
  );
}
