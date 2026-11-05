import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  approveMatchingSsrDrafts,
  listSsrDraftMatches,
} from "@/fetchers/ssr/ssr-fetchers";
import { HttpError } from "@/lib/http-error";
import { toast } from "@/lib/toast";
import { ApproveMatchingDialog } from "./approve-matching-dialog";

// One owner action for drafts whose bytes were already approved (same path
// and blob sha, proven by the server). The rest keep the per-item diff flow.
export function ApproveMatchingBar({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const drafts = useQuery({
    queryKey: ["ssr", "drafts", workspaceId],
    queryFn: () => listSsrDraftMatches(workspaceId),
  });
  const approve = useMutation({
    mutationFn: (versionIds: string[]) =>
      approveMatchingSsrDrafts(workspaceId, versionIds),
    onSuccess: (result) => {
      toast.success(
        t("workspace:ssr.approveMatching.done", { approved: result.approved }),
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

  if (drafts.isError) {
    return (
      <p className="text-destructive text-xs">{t("workspace:ssr.loadError")}</p>
    );
  }
  const list = drafts.data ?? [];
  if (list.length === 0) return null;
  const matching = list.filter((draft) => draft.match);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-4 py-3">
      <p className="text-sm">
        {t("workspace:ssr.approveMatching.summary", {
          total: list.length,
          matching: matching.length,
        })}
      </p>
      <Button
        type="button"
        size="sm"
        disabled={matching.length === 0 || approve.isPending}
        onClick={() => setOpen(true)}
      >
        {t("workspace:ssr.approveMatching.button", {
          matching: matching.length,
        })}
      </Button>
      <ApproveMatchingDialog
        open={open}
        onOpenChange={setOpen}
        matching={matching}
        rest={list.length - matching.length}
        pending={approve.isPending}
        onConfirm={() =>
          approve.mutate(matching.map((draft) => draft.versionId))
        }
      />
    </div>
  );
}
