import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  approveMatchingSsrDrafts,
  type SsrDraftMatch,
} from "@/fetchers/ssr/ssr-fetchers";
import { HttpError } from "@/lib/http-error";
import { toast } from "@/lib/toast";
import { ApproveMatchingDialog } from "./approve-matching-dialog";
import { planBatch } from "./approve-matching-plan";

// Same height loading and loaded, so the registry below does not jump while
// the matches arrive on a slow network.
const BAR =
  "min-h-[5.25rem] rounded-md border border-border bg-card px-4 py-3 sm:min-h-14";

// One owner action for drafts whose bytes the owner already approved (same
// path and blob sha, proven by the server). The rest keep the per-item diff
// flow; after a batch their paths are listed so they are easy to find.
export function ApproveMatchingBar({
  workspaceId,
  drafts,
  status,
  onLocate,
}: {
  workspaceId: string;
  drafts: SsrDraftMatch[] | undefined;
  status: "pending" | "error" | "success";
  onLocate: (entityId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [approvedIds, setApprovedIds] = useState<Set<string> | null>(null);
  const approve = useMutation({
    mutationFn: (items: Array<{ versionId: string; blobSha: string }>) =>
      approveMatchingSsrDrafts(workspaceId, items),
    onSuccess: (result) => {
      setApprovedIds(new Set(result.versionIds));
      toast.success(
        t("workspace:ssr.approveMatching.done", { count: result.approved }),
      );
    },
    onError: (error) => {
      toast.error(
        error instanceof HttpError && error.status === 409
          ? t("workspace:ssr.approveMatching.changed")
          : t("workspace:ssr.approveMatching.error"),
      );
    },
    onSettled: () => {
      setOpen(false);
      return queryClient.invalidateQueries({ queryKey: ["ssr"] });
    },
  });

  if (status === "pending") {
    return (
      <div className={`${BAR} text-muted-foreground text-sm`}>
        {t("common:loading")}
      </div>
    );
  }
  if (status === "error") {
    return (
      <p className={`${BAR} text-destructive text-sm`}>
        {t("workspace:ssr.loadError")}
      </p>
    );
  }
  // Until the refetch lands, the drafts just approved are still in the list.
  const list = (drafts ?? []).filter(
    (draft) => !approvedIds?.has(draft.versionId),
  );
  if (list.length === 0) return null;
  const { matching, batch, review, later } = planBatch(list);
  const label =
    later > 0
      ? t("workspace:ssr.approveMatching.buttonPartial", {
          batch: batch.length,
          matching: matching.length,
        })
      : t("workspace:ssr.approveMatching.button", {
          matching: matching.length,
        });

  return (
    <div className={`${BAR} flex flex-col gap-2`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          {t("workspace:ssr.approveMatching.summary", {
            total: list.length,
            matching: matching.length,
          })}
        </p>
        {matching.length > 0 ? (
          <Button
            type="button"
            size="sm"
            className="self-start sm:self-auto"
            disabled={approve.isPending}
            onClick={() => setOpen(true)}
          >
            {label}
          </Button>
        ) : null}
      </div>
      {approvedIds && review.length > 0 ? (
        <div>
          <p className="text-muted-foreground text-xs">
            {t("workspace:ssr.approveMatching.left", { count: review.length })}
          </p>
          <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-auto text-xs">
            {review.map((draft) => (
              <li key={draft.versionId} className="min-w-0">
                <button
                  type="button"
                  title={draft.path}
                  // At least a 24 px touch target (WCAG 2.5.8).
                  className="block min-h-6 min-w-6 max-w-full truncate py-1 text-left font-mono underline-offset-2 hover:underline"
                  onClick={() => onLocate(draft.entityId)}
                >
                  {draft.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {matching.length > 0 ? (
        <ApproveMatchingDialog
          open={open}
          onOpenChange={setOpen}
          batch={batch}
          later={later}
          review={review.length}
          confirmLabel={label}
          pending={approve.isPending}
          onConfirm={() =>
            approve.mutate(
              batch.map(({ versionId, blobSha }) => ({ versionId, blobSha })),
            )
          }
        />
      ) : null}
    </div>
  );
}
