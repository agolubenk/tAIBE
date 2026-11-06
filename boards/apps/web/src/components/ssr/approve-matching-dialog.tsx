import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { groupBySource, type MatchedDraft } from "./approve-matching-plan";

// The owner sees every path the one action approves, grouped by the
// workspace where they approved the same bytes, before confirming. On a
// phone the list scrolls and Cancel/Confirm stay on screen.
export function ApproveMatchingDialog({
  open,
  onOpenChange,
  batch,
  later,
  review,
  confirmLabel,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: MatchedDraft[];
  later: number;
  review: number;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const groups = groupBySource(batch);
  const count = batch.length;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workspace:ssr.approveMatching.title")}
      description={[
        t("workspace:ssr.approveMatching.description", {
          count,
          workspaces: groups.map((group) => group.workspaceName).join(", "),
        }),
        t("workspace:ssr.approveMatching.effect", { count }),
        later > 0
          ? t("workspace:ssr.approveMatching.later", { count: later })
          : null,
        review > 0
          ? t("workspace:ssr.approveMatching.rest", { count: review })
          : null,
      ]
        .filter(Boolean)
        .join(" ")}
      confirmLabel={confirmLabel}
      pendingLabel={t("workspace:ssr.approveMatching.pending")}
      pending={pending}
      destructive={false}
      onConfirm={onConfirm}
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div
        role="region"
        aria-label={t("workspace:ssr.approveMatching.listLabel")}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable from the keyboard (WCAG 2.1.1)
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border text-xs"
      >
        {groups.map((group) => (
          <section key={group.workspaceId}>
            <h3 className="bg-muted sticky top-0 px-3 py-1.5 font-medium">
              {t("workspace:ssr.approveMatching.group", {
                workspace: group.workspaceName,
                count: group.drafts.length,
              })}
            </h3>
            <ul>
              {group.drafts.map((draft) => (
                <li
                  key={draft.versionId}
                  title={draft.path}
                  className="border-border flex items-baseline gap-2 border-t px-3 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {draft.path}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    v{draft.match.number}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ConfirmDialog>
  );
}
