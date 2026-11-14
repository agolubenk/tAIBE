import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import useNotebookStatus from "@/hooks/queries/notebook/use-notebook-status";

// What the reader can expect right now: meaning-based search needs the Mac
// worker online, written answers need a model. Past the index budget only the
// newest chunks are searched by meaning (TB-76).
export function NotebookStatusBar({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useNotebookStatus(workspaceId);

  if (isLoading) return <Skeleton className="h-7 w-full rounded-lg" />;
  if (!data) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
      <Badge variant={data.workerOnline ? "success" : "warning"}>
        {data.workerOnline
          ? t("workspace:notebook.status.workerOnline")
          : t("workspace:notebook.status.workerOffline")}
      </Badge>
      <span>
        {t("workspace:notebook.status.counts", {
          sources: data.sources,
          chunks: data.chunks,
          embedded: data.embedded,
        })}
      </span>
      {data.indexed < data.embedded && (
        <Badge variant="warning">
          {t("workspace:notebook.status.indexCapped", {
            indexed: data.indexed,
            embedded: data.embedded,
          })}
        </Badge>
      )}
      <span>
        {data.llm.configured
          ? t("workspace:notebook.status.model", {
              model: data.llm.model,
              calls: data.llm.callsToday,
              max: data.llm.dailyMax,
            })
          : t("workspace:notebook.status.noModel")}
      </span>
    </div>
  );
}
