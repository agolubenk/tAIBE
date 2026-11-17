import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import useJournal from "@/hooks/queries/forest/use-journal";
import { ForestListState } from "./forest-list-state";
import { JournalRow } from "./journal-row";

const ACTORS = ["agent", "all"] as const;
type Actor = (typeof ACTORS)[number];

const isActor = (value: unknown): value is Actor =>
  (ACTORS as readonly unknown[]).includes(value);

// R-090: what agents did on the board, refused actions included (R-036).
export function JournalTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [actor, setActor] = useState<Actor>("agent");
  const [denied, setDenied] = useState(false);
  const journal = useJournal(workspaceId, { actor, denied });
  const items = journal.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.journal")}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[actor]}
          onValueChange={(value) => {
            const next = value[0];
            if (isActor(next)) setActor(next);
          }}
        >
          {ACTORS.map((item) => (
            <ToggleGroupItem key={item} value={item}>
              {t(`workspace:forest.journal.actor.${item}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Label className="flex items-center gap-2 font-normal text-sm">
          <Switch checked={denied} onCheckedChange={setDenied} />
          {t("workspace:forest.journal.deniedOnly")}
        </Label>
      </div>
      <ForestListState
        isLoading={journal.isLoading}
        isError={journal.isError}
        onRetry={() => void journal.refetch()}
        isEmpty={!items.length}
        empty={t("workspace:forest.journal.empty")}
      >
        <ul className="flex flex-col gap-2">
          {items.map((entry) => (
            <JournalRow
              key={entry.id}
              workspaceId={workspaceId}
              entry={entry}
            />
          ))}
        </ul>
        {journal.hasNextPage ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-center"
            disabled={journal.isFetchingNextPage}
            onClick={() => void journal.fetchNextPage()}
          >
            {t("workspace:forest.journal.loadMore")}
          </Button>
        ) : null}
      </ForestListState>
    </div>
  );
}
