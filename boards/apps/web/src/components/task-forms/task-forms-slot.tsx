import { type ComponentType, lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import useTaskForms from "@/hooks/queries/task-form/use-task-forms";

// TB-173: the place of the forms section in the task card. Every card loads
// this file, so it only decides whether to load the section: for forms, or
// to show that the list did not load. The section and @kaneo/forms load only
// then. While the list loads nothing is shown: most tasks have no forms. If
// the section chunk does not load, the card stays and shows no forms.

const TaskFormsSection = lazy<ComponentType<{ taskId: string }>>(() =>
  import("./task-forms-section").catch(() => ({ default: () => null })),
);

export function TaskFormsSlot({ taskId }: { taskId: string }) {
  const { data: forms, isError } = useTaskForms(taskId);
  const needed = forms ? forms.length > 0 : isError;
  if (!needed) return null;
  return (
    <Suspense fallback={<Skeleton className="mt-6 h-24 w-full" />}>
      <TaskFormsSection taskId={taskId} />
    </Suspense>
  );
}
