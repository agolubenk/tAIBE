import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";

type ForestTaskLinkProps = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  number: number | null;
  title: string;
  className?: string;
};

export function ForestTaskLink({
  workspaceId,
  projectId,
  taskId,
  number,
  title,
  className,
}: ForestTaskLinkProps) {
  return (
    <Link
      to="/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId"
      params={{ workspaceId, projectId, taskId }}
      // max-sm:py-1 — a 24 px touch target on a phone (WCAG 2.5.8, TB-223).
      className={cn(
        "min-w-0 truncate rounded-sm max-sm:py-1 text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {number !== null ? (
        <span className="mr-1.5 text-muted-foreground tabular-nums">
          #{number}
        </span>
      ) : null}
      {title}
    </Link>
  );
}
