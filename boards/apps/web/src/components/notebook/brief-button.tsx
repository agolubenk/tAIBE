import { ClipboardList } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import useBriefNotebookThread from "@/hooks/mutations/notebook/use-brief-notebook-thread";
import useNotebookStatus from "@/hooks/queries/notebook/use-notebook-status";
import { briefBlocked } from "./brief-blocked";

type BriefButtonProps = { workspaceId: string; threadId: string };

// TB-3: a GOAL / CONSTRAINTS / ACCEPTANCE brief of the thread, stored in it.
export function BriefButton({ workspaceId, threadId }: BriefButtonProps) {
  const { t } = useTranslation();
  const status = useNotebookStatus(workspaceId);
  const brief = useBriefNotebookThread(workspaceId);
  const hintId = useId();
  const blocked = briefBlocked(status.data?.llm);
  const pending = brief.isPending && brief.variables === threadId;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={!status.data || blocked !== null || brief.isPending}
        aria-describedby={blocked ? hintId : undefined}
        onClick={() => brief.mutate(threadId)}
      >
        <ClipboardList aria-hidden="true" />
        {pending
          ? t("workspace:notebook.chat.brief.pending")
          : t("workspace:notebook.chat.brief.button")}
      </Button>
      {blocked ? (
        <p
          id={hintId}
          className="max-w-56 text-right text-muted-foreground text-xs"
        >
          {t(`workspace:notebook.chat.brief.${blocked}`)}
        </p>
      ) : null}
    </div>
  );
}
