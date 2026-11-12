import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useDecideApproval from "@/hooks/mutations/forest/use-decide-approval";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { ApprovalSummary } from "./approval-summary";

const STATUS_VARIANT: Record<string, "success" | "error" | "secondary"> = {
  approved: "success",
  rejected: "error",
  consumed: "secondary",
  failed: "error",
};

type ApprovalItemProps = {
  workspaceId: string;
  approval: {
    id: string;
    action: string;
    params: Record<string, string> | null;
    reason: string | null;
    requestedByName: string;
    expiresAt: string;
    status?: string;
    failReason?: string | null;
    doneRef?: string | null;
    doneReason?: string | null;
  };
  target?: ReactNode;
};

// One request for the owner's «да» (N-011). Only the owner's own session can
// answer; the API refuses anyone else, so the buttons stay for everyone.
export function ApprovalItem({
  workspaceId,
  approval,
  target,
}: ApprovalItemProps) {
  const { t } = useTranslation();
  const decide = useDecideApproval(workspaceId);
  // With every status shown, an old request may still say pending.
  const expired = new Date(approval.expiresAt).getTime() <= Date.now();
  const status = approval.status ?? "pending";
  const shownStatus = status === "pending" && expired ? "expired" : status;
  const pending = shownStatus === "pending";

  const answer = (decision: "approved" | "rejected") =>
    decide.mutate({ workspaceId, approvalId: approval.id, decision });

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5",
        pending ? "border-warning/30 bg-warning/4" : "bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-2 font-medium text-[13px] text-foreground">
        <ApprovalSummary action={approval.action} params={approval.params} />
        {pending ? null : (
          <Badge variant={STATUS_VARIANT[shownStatus] ?? "outline"}>
            {t(`workspace:forest.approvals.status.${shownStatus}`)}
          </Badge>
        )}
      </div>
      {target}
      {approval.doneRef ? (
        <a
          href={approval.doneRef}
          target="_blank"
          rel="noreferrer"
          className="break-all text-primary text-xs underline-offset-2 hover:underline"
        >
          {approval.doneRef}
        </a>
      ) : approval.doneReason ? (
        <p className="text-muted-foreground text-xs">
          {t("workspace:forest.approvals.doneReason", {
            reason: approval.doneReason,
          })}
        </p>
      ) : null}
      {shownStatus === "failed" && approval.failReason ? (
        <p className="break-words text-destructive text-xs">
          {t("workspace:forest.approvals.failReason", {
            reason: approval.failReason,
          })}
        </p>
      ) : null}
      {approval.reason ? (
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground text-xs">
          {approval.reason}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        {t("workspace:forest.approvals.requestedBy", {
          name: approval.requestedByName,
        })}
        {" · "}
        <span title={formatDateTime(approval.expiresAt)}>
          {t("workspace:forest.approvals.expires", {
            time: formatRelativeTime(approval.expiresAt),
          })}
        </span>
      </p>
      {pending ? (
        <div className="flex gap-1.5 pt-0.5">
          <Button
            size="xs"
            disabled={decide.isPending}
            onClick={() => answer("approved")}
          >
            <Check aria-hidden="true" />
            {t("workspace:forest.approvals.approve")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => answer("rejected")}
          >
            <X aria-hidden="true" />
            {t("workspace:forest.approvals.reject")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
