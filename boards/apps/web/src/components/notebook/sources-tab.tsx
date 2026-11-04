import { useTranslation } from "react-i18next";
import { ForestListState } from "@/components/forest/forest-list-state";
import useNotebookSources from "@/hooks/queries/notebook/use-notebook-sources";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { AddSourceForm } from "./add-source-form";
import { SourceRow } from "./source-row";

// What the Mac agent has synced (R-050), the board's cards, and the links and
// PRs added here, with how much of it already has vectors.
export function SourcesTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const sources = useNotebookSources(workspaceId);
  const { canManageSettings } = useWorkspacePermission();
  // A hint only: the API checks manage_settings on every add.
  const canAdd = canManageSettings();
  const list = sources.data?.sources ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:notebook.hints.sources")}
      </p>
      {canAdd ? <AddSourceForm workspaceId={workspaceId} /> : null}
      <ForestListState
        isLoading={sources.isLoading}
        isError={sources.isError}
        isEmpty={list.length === 0}
        empty={t("workspace:notebook.sources.empty")}
      >
        <p className="text-muted-foreground text-xs">
          {t("workspace:notebook.sources.model", {
            model: sources.data?.model,
          })}
        </p>
        <ul className="divide-y rounded-lg border bg-card">
          {list.map((source) => (
            <SourceRow
              key={`${source.kind}:${source.ref}`}
              workspaceId={workspaceId}
              source={source}
              canRefresh={canAdd}
            />
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
