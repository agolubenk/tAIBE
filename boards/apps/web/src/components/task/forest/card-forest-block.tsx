import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import useCardContext from "@/hooks/queries/forest/use-card-context";
import { cn } from "@/lib/cn";
import { CardPanel } from "./card-panel";

type CardForestBlockProps = {
  workspaceId: string;
  taskId: string;
  className?: string;
};

// The full card on a phone: the forest sections sit in one block between the
// properties and the description, collapsed by default (owner, 15.11,
// taibe-d-tb61-forest-place-1511 = a). The panel mounts only while it is open;
// the count of «да» requests stays on the closed block so they are not hidden.
export function CardForestBlock({
  workspaceId,
  taskId,
  className,
}: CardForestBlockProps) {
  const { t } = useTranslation();
  const { data } = useCardContext(workspaceId, taskId);
  const waiting = data?.approvals.length ?? 0;

  return (
    <Collapsible className={cn("border-border/60 border-y", className)}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring data-panel-open:[&>svg]:rotate-90">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform"
        />
        {t("tasks:card.forest.title")}
        {waiting ? (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-normal text-foreground text-xs tabular-nums">
            {t("tasks:card.sections.approvals")} · {waiting}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <CardPanel workspaceId={workspaceId} taskId={taskId} className="pb-3" />
      </CollapsiblePanel>
    </Collapsible>
  );
}
