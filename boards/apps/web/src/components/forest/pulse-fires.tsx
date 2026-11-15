import { Flame } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import useFires from "@/hooks/queries/forest/use-fires";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { getSeverityLabel } from "@/lib/i18n/domain";
import { ForestListState } from "./forest-list-state";
import { ForestTaskLink } from "./forest-task-link";
import { PulseSection } from "./pulse-section";

// Open bugs and urgent cards, hot bugs first (R-090).
export function PulseFires({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const fires = useFires(workspaceId);

  return (
    <PulseSection
      title={t("workspace:forest.pulse.fires")}
      count={fires.data?.total}
    >
      <ForestListState
        isLoading={fires.isLoading}
        isError={fires.isError}
        onRetry={() => void fires.refetch()}
        isEmpty={!fires.data?.items.length}
        empty={t("workspace:forest.pulse.firesEmpty")}
      >
        <ul className="flex flex-col gap-1.5">
          {fires.data?.items.map((fire) => (
            <li
              key={fire.taskId}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm"
            >
              {fire.hot ? (
                <Flame
                  aria-label={t("workspace:forest.pulse.hot")}
                  className="size-3.5 text-destructive-foreground"
                />
              ) : null}
              <ForestTaskLink
                workspaceId={workspaceId}
                projectId={fire.projectId}
                taskId={fire.taskId}
                number={fire.number}
                title={fire.title}
              />
              {fire.kind === "bug" ? (
                <Badge variant={fire.hot ? "error" : "warning"}>
                  {fire.severity
                    ? t("workspace:forest.pulse.bugSeverity", {
                        severity: getSeverityLabel(fire.severity),
                      })
                    : t("workspace:forest.pulse.bug")}
                </Badge>
              ) : null}
              {fire.priority === "urgent" ? (
                <Badge variant="warning">
                  {t("workspace:forest.pulse.urgent")}
                </Badge>
              ) : null}
              <Badge variant="outline">{fire.projectName}</Badge>
              <span
                className="ms-auto text-muted-foreground text-xs"
                title={formatDateTime(fire.createdAt)}
              >
                {t("workspace:forest.pulse.since", {
                  when: formatRelativeTime(fire.createdAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      </ForestListState>
    </PulseSection>
  );
}
