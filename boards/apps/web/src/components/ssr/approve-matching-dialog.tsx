import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import type { SsrDraftMatch } from "@/fetchers/ssr/ssr-fetchers";

// The owner sees every path the one action approves and where its twin was
// approved before confirming; everything else stays for per-item review.
export function ApproveMatchingDialog({
  open,
  onOpenChange,
  matching,
  rest,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matching: SsrDraftMatch[];
  rest: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workspace:ssr.approveMatching.title")}
      description={t("workspace:ssr.approveMatching.description", {
        matching: matching.length,
        rest,
      })}
      confirmLabel={t("workspace:ssr.approveMatching.button", {
        matching: matching.length,
      })}
      pendingLabel={t("workspace:ssr.approveMatching.pending")}
      pending={pending}
      destructive={false}
      onConfirm={onConfirm}
    >
      <ul className="max-h-72 overflow-auto rounded-md border border-border text-xs">
        {matching.map((draft) => (
          <li
            key={draft.versionId}
            className="border-border flex flex-wrap items-baseline justify-between gap-2 border-t px-3 py-1.5 first:border-t-0"
          >
            <span className="font-mono break-all">{draft.path}</span>
            {draft.match ? (
              <span className="text-muted-foreground">
                {t("workspace:ssr.approveMatching.approvedIn", {
                  workspace: draft.match.workspaceName,
                  number: draft.match.number,
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
