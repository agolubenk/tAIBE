import { Search, Sprout } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import useLogs from "@/hooks/queries/forest/use-logs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ForestListState } from "./forest-list-state";
import { GrowDialog } from "./grow-dialog";
import { LogRow } from "./log-row";

const SEARCH_DELAY_MS = 300;
// The API grows at most this many seeds at once.
const SEEDS_MAX = 100;

export function LogsTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const logs = useLogs(workspaceId, search);
  // Seeds can come from several logs: the selection outlives an open row.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [growing, setGrowing] = useState(false);
  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];

  const toggle = (seedId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked && next.size < SEEDS_MAX) next.add(seedId);
      else next.delete(seedId);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("workspace:forest.hints.logs")}
        </p>
        <div className="relative w-full sm:w-64">
          <Search
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
          />
          <Input
            type="search"
            size="sm"
            className="pl-8"
            value={query}
            aria-label={t("workspace:forest.logs.search")}
            placeholder={t("workspace:forest.logs.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <ForestListState
        isLoading={logs.isLoading}
        isError={logs.isError}
        onRetry={() => void logs.refetch()}
        isEmpty={!items.length}
        empty={t("workspace:forest.logs.empty")}
      >
        <ul className="flex flex-col gap-2">
          {items.map((log) => (
            <LogRow
              key={log.id}
              workspaceId={workspaceId}
              log={log}
              selected={selected}
              onToggle={toggle}
            />
          ))}
        </ul>
        {logs.hasNextPage ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-center"
            disabled={logs.isFetchingNextPage}
            onClick={() => void logs.fetchNextPage()}
          >
            {t("workspace:forest.logs.loadMore")}
          </Button>
        ) : null}
      </ForestListState>
      {selected.size > 0 ? (
        <div className="sticky bottom-3 flex flex-wrap items-center gap-2 self-center rounded-xl border bg-popover px-3 py-2 shadow-lg">
          <span className="text-sm">
            {t("workspace:forest.logs.selected", { seeds: selected.size })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            {t("workspace:forest.logs.clear")}
          </Button>
          <Button size="xs" onClick={() => setGrowing(true)}>
            <Sprout aria-hidden="true" />
            {t("workspace:forest.grow.open")}
          </Button>
        </div>
      ) : null}
      <GrowDialog
        workspaceId={workspaceId}
        seedIds={[...selected]}
        open={growing}
        onOpenChange={setGrowing}
        onGrown={() => setSelected(new Set())}
      />
    </div>
  );
}
