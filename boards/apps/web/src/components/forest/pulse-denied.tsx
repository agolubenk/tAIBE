import { useTranslation } from "react-i18next";
import useJournal from "@/hooks/queries/forest/use-journal";
import { ForestListState } from "./forest-list-state";
import type { ForestTab } from "./forest-types";
import { JournalRow } from "./journal-row";
import { PulseSection } from "./pulse-section";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHOWN = 5;
const DENIED = { actor: "all", denied: true } as const;

// Refused actions of the last day: an agent hitting the guard again and again
// is something to look at (R-036, AC-021, AC-027).
export function PulseDenied({
  workspaceId,
  onTabChange,
}: {
  workspaceId: string;
  onTabChange: (tab: ForestTab) => void;
}) {
  const { t } = useTranslation();
  const journal = useJournal(workspaceId, DENIED);
  const since = Date.now() - DAY_MS;
  const recent = (journal.data?.pages[0]?.items ?? []).filter(
    (entry) => new Date(entry.createdAt).getTime() >= since,
  );

  return (
    <PulseSection
      title={t("workspace:forest.pulse.denied")}
      count={recent.length}
      action={{
        label: t("workspace:forest.pulse.toJournal"),
        onClick: () => onTabChange("journal"),
      }}
    >
      <ForestListState
        isLoading={journal.isLoading}
        isError={journal.isError}
        onRetry={() => void journal.refetch()}
        isEmpty={!recent.length}
        empty={t("workspace:forest.pulse.deniedEmpty")}
      >
        <ul className="flex flex-col gap-1.5">
          {recent.slice(0, SHOWN).map((entry) => (
            <JournalRow
              key={entry.id}
              workspaceId={workspaceId}
              entry={entry}
            />
          ))}
        </ul>
      </ForestListState>
    </PulseSection>
  );
}
