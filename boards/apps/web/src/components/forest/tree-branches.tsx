import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import useTree from "@/hooks/queries/forest/use-tree";
import { getStatusLabel } from "@/lib/i18n/domain";
import { ForestTaskLink } from "./forest-task-link";
import { orderBranches } from "./order-branches";

const INDENT_REM = 1.25;

type TreeBranchesProps = {
  workspaceId: string;
  rootId: string;
};

// The subtasks under one root, indented by depth; loads when the tree opens.
export function TreeBranches({ workspaceId, rootId }: TreeBranchesProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useTree(workspaceId, rootId, true);

  if (isLoading) return <Skeleton className="h-6 w-2/3" />;
  if (isError || !data) {
    return (
      <p role="alert" className="text-muted-foreground text-xs">
        {t("workspace:forest.loadError")}
      </p>
    );
  }
  const branches = orderBranches(rootId, data.branches);
  if (!branches.length) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("workspace:forest.trees.noBranches")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {branches.map((branch) => (
        <li
          key={branch.id}
          className="flex items-center gap-2 text-[13px]"
          style={{ paddingLeft: `${(branch.depth - 1) * INDENT_REM}rem` }}
        >
          <span aria-hidden="true" className="text-muted-foreground/60">
            └
          </span>
          <ForestTaskLink
            workspaceId={workspaceId}
            projectId={branch.projectId}
            taskId={branch.id}
            number={branch.number}
            title={branch.title}
          />
          <span className="shrink-0 text-muted-foreground text-xs">
            {getStatusLabel(branch.status)}
          </span>
        </li>
      ))}
      {data.truncated ? (
        <li className="text-muted-foreground text-xs">
          {t("workspace:forest.trees.branchesTruncated")}
        </li>
      ) : null}
    </ul>
  );
}
