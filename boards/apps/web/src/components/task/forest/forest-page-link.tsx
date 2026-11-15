import { Link } from "@tanstack/react-router";
import { Trees } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

type ForestPageLinkProps = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  className?: string;
};

// The board sheet stays light: no forest sections and no forest requests,
// only this link to the full card where they live (owner, 15.11,
// taibe-d-tb61-forest-place-1511 = a).
export function ForestPageLink({
  workspaceId,
  projectId,
  taskId,
  className,
}: ForestPageLinkProps) {
  const { t } = useTranslation();

  return (
    <Link
      to="/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId"
      params={{ workspaceId, projectId, taskId }}
      className={cn(
        "flex min-h-6 w-fit items-center gap-1.5 rounded-sm text-muted-foreground text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Trees aria-hidden="true" className="size-3.5 shrink-0" />
      {t("tasks:card.forest.openPage")}
    </Link>
  );
}
