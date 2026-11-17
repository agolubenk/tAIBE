import { Bug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import useBoardBugs from "@/hooks/queries/forest/use-board-bugs";
import { getSeverityLabel } from "@/lib/i18n/domain";

type TaskCardBugProps = {
  workspaceId: string;
  projectId: string;
  taskId: string;
};

// A bug is a card on the same board and in the same columns as a task (owner,
// 30.10); the mark tells it apart, with its severity when the card has one.
export function TaskCardBug({
  workspaceId,
  projectId,
  taskId,
}: TaskCardBugProps) {
  const { t } = useTranslation();
  const { data } = useBoardBugs(workspaceId, projectId);
  const bug = data?.get(taskId);
  if (!bug) return null;

  return (
    <Badge variant="error">
      <Bug aria-hidden="true" className="size-3" />
      {t("tasks:card.kind.bug")}
      {bug.severity && (
        <span className="opacity-80">· {getSeverityLabel(bug.severity)}</span>
      )}
    </Badge>
  );
}
