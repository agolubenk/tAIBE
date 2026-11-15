import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import useTaskForms from "@/hooks/queries/task-form/use-task-forms";

// TB-173: the place of the forms section in the task card. This file is in
// the card's chunk and stays small; the section and @kaneo/forms load only
// when the task has forms. While the list loads nothing is shown: most tasks
// have no forms, and a placeholder on every card would be noise.

const TaskFormsSection = lazy(() => import("./task-forms-section"));

export function TaskFormsSlot({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data: forms, isError, isFetching, refetch } = useTaskForms(taskId);
  // Wait for the newest list once; after that the section stays mounted, so
  // a later refetch never drops answers that are being typed.
  const [shown, setShown] = useState(false);

  if (!forms) {
    if (!isError) return null;
    return (
      <div className="mt-6 flex items-center gap-2" role="alert">
        <p className="text-muted-foreground text-sm">
          {t("tasks:forms.loadError")}
        </p>
        <Button onClick={() => void refetch()} size="xs" variant="outline">
          {t("tasks:forms.retry")}
        </Button>
      </div>
    );
  }
  if (forms.length === 0 || (isFetching && !shown)) return null;
  if (!shown) setShown(true);
  return (
    <Suspense fallback={<Skeleton className="mt-6 h-24 w-full" />}>
      <TaskFormsSection forms={forms} taskId={taskId} />
    </Suspense>
  );
}
