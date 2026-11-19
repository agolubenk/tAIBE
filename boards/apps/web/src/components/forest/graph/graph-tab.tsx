import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import useGraph from "@/hooks/queries/forest/use-graph";
import { ForestListState } from "../forest-list-state";
import { CLUSTER_AT, clusterGraph } from "./cluster-graph";
import { GraphCanvas } from "./graph-canvas";
import { GraphDetails } from "./graph-details";
import { filterGraph, mergeGraphPages } from "./graph-model";

const NO_GROUPS: ReadonlySet<string> = new Set();

// R-090: cards, the files they touched and the decisions they cite, joined
// by their links and grouped by sector (R-029). Loaded on its own through
// import(), so the board never pays for it (AC-018).
export function GraphTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const graph = useGraph(workspaceId);
  const [files, setFiles] = useState(true);
  const [decisions, setDecisions] = useState(true);
  const [expanded, setExpanded] = useState(NO_GROUPS);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pages = graph.data?.pages;
  const merged = useMemo(() => mergeGraphPages(pages ?? []), [pages]);
  const view = useMemo(
    () => clusterGraph(filterGraph(merged, { files, decisions }), expanded),
    [merged, files, decisions, expanded],
  );
  const counted = (kind: string) =>
    String(merged.nodes.filter((node) => node.kind === kind).length);
  const selected = view.nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.graph")}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Label className="flex items-center gap-2 font-normal text-sm">
          <Switch checked={files} onCheckedChange={setFiles} />
          {t("workspace:forest.graph.files")}
        </Label>
        <Label className="flex items-center gap-2 font-normal text-sm">
          <Switch checked={decisions} onCheckedChange={setDecisions} />
          {t("workspace:forest.graph.decisions")}
        </Label>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("workspace:forest.graph.counts", {
            cards: counted("card"),
            files: counted("file"),
            decisions: counted("decision"),
          })}
        </span>
      </div>
      <ForestListState
        isLoading={graph.isLoading}
        isError={graph.isError}
        onRetry={() => void graph.refetch()}
        isEmpty={!merged.nodes.length}
        empty={t("workspace:forest.graph.empty")}
      >
        {view.clustered || expanded.size ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>
              {t("workspace:forest.graph.clustered", {
                max: String(CLUSTER_AT),
              })}
            </span>
            {expanded.size ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setExpanded(NO_GROUPS)}
              >
                {t("workspace:forest.graph.collapseAll")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <GraphCanvas
          graph={view}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
        <GraphDetails
          workspaceId={workspaceId}
          graph={view}
          node={selected}
          onSelect={setSelectedId}
          onExpand={(group) => {
            setExpanded(new Set([...expanded, group]));
            setSelectedId(null);
          }}
        />
        {graph.hasNextPage ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-center"
            disabled={graph.isFetchingNextPage}
            onClick={() => void graph.fetchNextPage()}
          >
            {t("workspace:forest.graph.loadMore")}
          </Button>
        ) : null}
      </ForestListState>
    </div>
  );
}
