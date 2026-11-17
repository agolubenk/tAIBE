import { useTranslation } from "react-i18next";
import useApprovals from "@/hooks/queries/forest/use-approvals";
import useWorkState from "@/hooks/queries/forest/use-work-state";
import { ApprovalSummary } from "./approval-summary";
import { ApprovalTarget } from "./approval-target";
import { ForestListState } from "./forest-list-state";
import { ForestTaskLink } from "./forest-task-link";
import type { ForestTab } from "./forest-types";
import { PulseSection } from "./pulse-section";

const SHOWN = 5;

// What waits for you: «да» requests (N-011) and sessions that said what they
// wait for (R-037). The panel shows the first few; the tabs hold the rest.
export function PulseWaiting({
  workspaceId,
  onTabChange,
}: {
  workspaceId: string;
  onTabChange: (tab: ForestTab) => void;
}) {
  const { t } = useTranslation();
  const approvals = useApprovals(workspaceId, "pending");
  const sessions = useWorkState(workspaceId);
  const pending = approvals.data?.items ?? [];
  const waiting = (sessions.data ?? []).filter((session) => session.waiting);

  return (
    <PulseSection
      title={t("workspace:forest.pulse.waiting")}
      count={pending.length + waiting.length}
      action={{
        label: t("workspace:forest.pulse.toApprovals"),
        onClick: () => onTabChange("approvals"),
      }}
    >
      <ForestListState
        isLoading={approvals.isLoading || sessions.isLoading}
        isError={approvals.isError || sessions.isError}
        onRetry={() => {
          void approvals.refetch();
          void sessions.refetch();
        }}
        isEmpty={!pending.length && !waiting.length}
        empty={t("workspace:forest.pulse.waitingEmpty")}
      >
        <ul className="flex flex-col gap-1.5">
          {pending.slice(0, SHOWN).map((approval) => (
            <li
              key={approval.id}
              className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm"
            >
              <span>
                <ApprovalSummary
                  action={approval.action}
                  params={approval.params}
                />
                <span className="text-muted-foreground">
                  {" · "}
                  {approval.requestedByName}
                </span>
              </span>
              <ApprovalTarget workspaceId={workspaceId} approval={approval} />
            </li>
          ))}
          {waiting.slice(0, SHOWN).map((session) => (
            <li
              key={`${session.actorKind}:${session.actorName}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-3 py-2 text-sm"
            >
              <span className="font-medium">{session.actorName}</span>
              <span>
                {t("workspace:forest.sessions.waiting", {
                  waiting: session.waiting,
                })}
              </span>
              {session.taskId && session.projectId && session.title ? (
                <ForestTaskLink
                  workspaceId={workspaceId}
                  projectId={session.projectId}
                  taskId={session.taskId}
                  number={session.number}
                  title={session.title}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </ForestListState>
    </PulseSection>
  );
}
