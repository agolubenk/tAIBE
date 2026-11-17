import { useTranslation } from "react-i18next";
import useStartMirrorRun from "@/hooks/mutations/forest/use-start-mirror-run";
import useMirrorRuns from "@/hooks/queries/forest/use-mirror-runs";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { ForestListState } from "./forest-list-state";
import { MirrorDatabaseReport } from "./mirror-database-report";
import { MirrorRunList } from "./mirror-run-list";
import { MirrorStreak } from "./mirror-streak";

// The scheduled Notion mirror as the owner sees it (AC-002, AC-003).
export function MirrorTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const mirror = useMirrorRuns(workspaceId);
  const start = useStartMirrorRun(workspaceId);
  const { canManageSettings } = useWorkspacePermission();
  const data = mirror.data;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.mirror")}
      </p>
      <ForestListState
        isLoading={mirror.isLoading}
        isError={mirror.isError}
        onRetry={() => void mirror.refetch()}
        isEmpty={false}
        empty=""
      >
        {data ? (
          <>
            <MirrorStreak
              mirror={data}
              canRun={canManageSettings()}
              isStarting={start.isPending}
              onRun={() => start.mutate()}
            />
            {data.latest?.report.databases.map((database) => (
              <MirrorDatabaseReport
                key={database.databaseId}
                database={database}
              />
            ))}
            {data.runs.length > 0 ? (
              <MirrorRunList runs={data.runs} />
            ) : (
              <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
                {t("workspace:forest.mirror.runs.empty")}
              </p>
            )}
          </>
        ) : null}
      </ForestListState>
    </div>
  );
}
