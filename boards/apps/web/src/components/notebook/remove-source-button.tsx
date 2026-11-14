import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { Button } from "@/components/ui/button";
import useRemoveNotebookSource from "@/hooks/mutations/notebook/use-remove-notebook-source";
import type { AddedSourceKind } from "./added-source-kind";

type RemoveSourceButtonProps = {
  workspaceId: string;
  kind: AddedSourceKind;
  ref_: string;
  title: string;
};

// TB-132: a link or a PR added by mistake leaves the notebook with its chunks.
// The synced kinds have no button: their next sync would bring them back.
export function RemoveSourceButton({
  workspaceId,
  kind,
  ref_,
  title,
}: RemoveSourceButtonProps) {
  const { t } = useTranslation();
  const remove = useRemoveNotebookSource(workspaceId);
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("workspace:notebook.sources.remove", { title })}
        title={t("workspace:notebook.sources.remove", { title })}
        disabled={remove.isPending}
        onClick={() => setConfirming(true)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("workspace:notebook.sources.removeTitle")}
        description={t("workspace:notebook.sources.removeDescription", {
          title,
        })}
        confirmLabel={t("workspace:notebook.sources.removeConfirm")}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { kind, ref: ref_, title },
            { onSuccess: () => setConfirming(false) },
          )
        }
      />
    </>
  );
}
