import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useSectors from "@/hooks/queries/forest/use-sectors";
import useTrees from "@/hooks/queries/forest/use-trees";
import useGetProjects from "@/hooks/queries/project/use-get-projects";
import { ForestListState } from "./forest-list-state";
import { TreeRow } from "./tree-row";

const ALL = "all";

export function TreesTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(ALL);
  const { data: projects = [] } = useGetProjects({ workspaceId });
  const trees = useTrees(
    workspaceId,
    projectId === ALL ? undefined : projectId,
  );
  const { data: sectors = [] } = useSectors(workspaceId);
  const sectorNames = useMemo(
    () => new Map(sectors.map((sector) => [sector.id, sector.name])),
    [sectors],
  );
  const projectName =
    projects.find((project) => project.id === projectId)?.name ??
    t("workspace:forest.trees.allProjects");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("workspace:forest.hints.trees")}
        </p>
        <Select
          value={projectId}
          onValueChange={(value) => {
            if (typeof value === "string") setProjectId(value);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("workspace:forest.trees.project")}
          >
            <SelectValue>{projectName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("workspace:forest.trees.allProjects")}
            </SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ForestListState
        isLoading={trees.isLoading}
        isError={trees.isError}
        onRetry={() => void trees.refetch()}
        isEmpty={!trees.data?.trees.length}
        empty={t("workspace:forest.trees.empty")}
      >
        <ul className="flex flex-col gap-2">
          {trees.data?.trees.map((tree) => (
            <TreeRow
              key={tree.id}
              workspaceId={workspaceId}
              tree={tree}
              sectorNames={sectorNames}
            />
          ))}
        </ul>
        {trees.data?.truncated ? (
          <p className="text-muted-foreground text-xs">
            {t("workspace:forest.trees.truncated")}
          </p>
        ) : null}
      </ForestListState>
    </div>
  );
}
