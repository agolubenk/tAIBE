import { Bot, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import useLeases from "@/hooks/queries/forest/use-leases";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { ForestListState } from "./forest-list-state";
import { ForestTaskLink } from "./forest-task-link";

export function LeasesTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const leases = useLeases(workspaceId);

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.leases")}
      </p>
      <ForestListState
        isLoading={leases.isLoading}
        isError={leases.isError}
        onRetry={() => void leases.refetch()}
        isEmpty={!leases.data?.length}
        empty={t("workspace:forest.leases.empty")}
      >
        <ul className="flex flex-col gap-2">
          {leases.data?.map((lease) => (
            <li
              key={lease.taskId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2"
            >
              <ForestTaskLink
                workspaceId={workspaceId}
                projectId={lease.projectId}
                taskId={lease.taskId}
                number={lease.number}
                title={lease.title}
                className="flex-1 font-medium text-sm"
              />
              <Badge variant="outline">{lease.projectName}</Badge>
              <span className="flex items-center gap-1.5 text-sm">
                {lease.holderKind === "agent" ? (
                  <Bot aria-hidden="true" className="size-3.5" />
                ) : (
                  <User aria-hidden="true" className="size-3.5" />
                )}
                {lease.holderName}
              </span>
              {lease.groupKey ? (
                <Badge variant="secondary">
                  {t("workspace:forest.leases.group", {
                    group: lease.groupKey,
                  })}
                </Badge>
              ) : null}
              <span
                className="text-muted-foreground text-xs"
                title={formatDateTime(lease.expiresAt)}
              >
                {t("workspace:forest.leases.window", {
                  taken: formatRelativeTime(lease.acquiredAt),
                  expires: formatRelativeTime(lease.expiresAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
