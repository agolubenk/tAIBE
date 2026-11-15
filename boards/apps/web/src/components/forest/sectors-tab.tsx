import { ScanSearch } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import useDetectSectors from "@/hooks/mutations/forest/use-detect-sectors";
import useSectors from "@/hooks/queries/forest/use-sectors";
import useTrees from "@/hooks/queries/forest/use-trees";
import { ForestListState } from "./forest-list-state";
import { SectorRow } from "./sector-row";

type SectorsTabProps = {
  workspaceId: string;
  // The sector the command palette jumped to (R-090).
  sectorId?: string;
};

export function SectorsTab({ workspaceId, sectorId }: SectorsTabProps) {
  const { t } = useTranslation();
  const sectors = useSectors(workspaceId);
  const { data: trees } = useTrees(workspaceId);
  const detect = useDetectSectors(workspaceId);
  const treesById = useMemo(
    () => new Map((trees?.trees ?? []).map((tree) => [tree.id, tree])),
    [trees],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("workspace:forest.hints.sectors")}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={detect.isPending}
          onClick={() => detect.mutate()}
        >
          <ScanSearch aria-hidden="true" />
          {t("workspace:forest.sectors.detect")}
        </Button>
      </div>
      <ForestListState
        isLoading={sectors.isLoading}
        isError={sectors.isError}
        onRetry={() => void sectors.refetch()}
        isEmpty={!sectors.data?.length}
        empty={t("workspace:forest.sectors.empty")}
      >
        <ul className="flex flex-col gap-2">
          {sectors.data?.map((sector) => (
            <SectorRow
              key={sector.id}
              workspaceId={workspaceId}
              sector={sector}
              trees={treesById}
              focused={sector.id === sectorId}
            />
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
