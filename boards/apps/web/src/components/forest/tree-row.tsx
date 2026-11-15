import { Axe, ChevronRight, GitBranch, Lock } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { getStatusLabel } from "@/lib/i18n/domain";
import { FellDialog } from "./fell-dialog";
import { ForestTaskLink } from "./forest-task-link";
import type { ForestTree } from "./forest-types";
import { TreeBranches } from "./tree-branches";

type TreeRowProps = {
  workspaceId: string;
  tree: ForestTree;
  sectorNames: Map<string, string>;
};

export function TreeRow({ workspaceId, tree, sectorNames }: TreeRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [felling, setFelling] = useState(false);
  const subject = `${tree.number !== null ? `#${tree.number} ` : ""}${tree.title}`;

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={t("workspace:forest.trees.toggle")}
          disabled={tree.branchCount === 0}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("transition-transform", open && "rotate-90")}
          />
        </Button>
        <ForestTaskLink
          workspaceId={workspaceId}
          projectId={tree.projectId}
          taskId={tree.id}
          number={tree.number}
          title={tree.title}
          className={cn(
            "flex-1 font-medium text-sm",
            tree.isCompleted && "text-muted-foreground line-through",
          )}
        />
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          <Badge variant="outline">{tree.projectName}</Badge>
          <Badge variant={tree.isCompleted ? "success" : "secondary"}>
            {getStatusLabel(tree.status)}
          </Badge>
          <Badge variant="outline">
            <GitBranch aria-hidden="true" />
            {t("workspace:forest.trees.branches", {
              branches: tree.branchCount,
            })}
          </Badge>
          {tree.lease ? (
            <Badge
              variant="warning"
              title={formatDateTime(tree.lease.expiresAt)}
            >
              <Lock aria-hidden="true" />
              {t("workspace:forest.trees.leasedBy", {
                name: tree.lease.holderName,
                time: formatRelativeTime(tree.lease.expiresAt),
              })}
            </Badge>
          ) : null}
          {tree.sectorIds.map((sectorId) => {
            const sector = t("workspace:forest.trees.sector", {
              name: sectorNames.get(sectorId) ?? "…",
            });
            return (
              <Badge key={sectorId} variant="info" className="max-w-full">
                <span className="truncate" title={sector}>
                  {sector}
                </span>
              </Badge>
            );
          })}
          <Button size="xs" variant="ghost" onClick={() => setFelling(true)}>
            <Axe aria-hidden="true" />
            {t("workspace:forest.fell.submit")}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="border-t px-4 py-2.5">
          <TreeBranches workspaceId={workspaceId} rootId={tree.id} />
        </div>
      ) : null}
      <FellDialog
        workspaceId={workspaceId}
        target={{ kind: "tree", rootId: tree.id }}
        subject={subject}
        open={felling}
        onOpenChange={setFelling}
      />
    </li>
  );
}
