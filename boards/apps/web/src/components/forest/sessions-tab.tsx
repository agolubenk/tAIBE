import { Bot, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import useWorkState from "@/hooks/queries/forest/use-work-state";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { ForestListState } from "./forest-list-state";
import { ForestTaskLink } from "./forest-task-link";

// R-037: each session's step, branch and what it waits for, latest first.
export function SessionsTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const sessions = useWorkState(workspaceId);

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-muted-foreground text-sm">
        {t("workspace:forest.hints.sessions")}
      </p>
      <ForestListState
        isLoading={sessions.isLoading}
        isError={sessions.isError}
        onRetry={() => void sessions.refetch()}
        isEmpty={!sessions.data?.length}
        empty={t("workspace:forest.sessions.empty")}
      >
        <ul className="flex flex-col gap-2">
          {sessions.data?.map((session) => (
            <li
              key={`${session.actorKind}:${session.actorName}:${session.updatedAt}`}
              className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5 font-medium text-sm">
                  {session.actorKind === "agent" ? (
                    <Bot aria-hidden="true" className="size-3.5" />
                  ) : (
                    <User aria-hidden="true" className="size-3.5" />
                  )}
                  {session.actorName}
                </span>
                {session.taskId && session.projectId && session.title ? (
                  <ForestTaskLink
                    workspaceId={workspaceId}
                    projectId={session.projectId}
                    taskId={session.taskId}
                    number={session.number}
                    title={session.title}
                    className="text-sm"
                  />
                ) : null}
                {session.projectName ? (
                  <Badge variant="outline">{session.projectName}</Badge>
                ) : null}
                <span
                  className="ms-auto text-muted-foreground text-xs"
                  title={formatDateTime(session.updatedAt)}
                >
                  {t("workspace:forest.sessions.updated", {
                    when: formatRelativeTime(session.updatedAt),
                  })}
                </span>
              </div>
              <p className="text-sm">{session.step}</p>
              {session.branch || session.waiting ? (
                <div className="flex flex-wrap gap-1.5">
                  {session.branch ? (
                    <Badge variant="secondary" className="font-mono">
                      {t("workspace:forest.sessions.branch", {
                        branch: session.branch,
                      })}
                    </Badge>
                  ) : null}
                  {session.waiting ? (
                    <Badge variant="outline">
                      {t("workspace:forest.sessions.waiting", {
                        waiting: session.waiting,
                      })}
                    </Badge>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </ForestListState>
    </div>
  );
}
